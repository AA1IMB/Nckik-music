// nckik-audio.exe — Nckik's music WASAPI Exclusive 轻量原生音频子进程
// 职责：枚举音频渲染端点、本地音频无损/有损解码（WAV 直解 + Media Foundation）、
//       WASAPI Exclusive（事件驱动优先 + 定时模式回退）自适应采样率/位深直通、
//       硬件音量查询/软件高精度缩放、精确 IAudioClock 时钟锚点与热插拔安全停播。

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <endpointvolume.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <propvarutil.h>
#include <ks.h>
#include <ksmedia.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <io.h>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifndef AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED
#define AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED ((HRESULT)0x88890019)
#endif
#ifndef AUDCLNT_E_DEVICE_IN_USE
#define AUDCLNT_E_DEVICE_IN_USE ((HRESULT)0x8889000A)
#endif
#ifndef AUDCLNT_E_DEVICE_INVALIDATED
#define AUDCLNT_E_DEVICE_INVALIDATED ((HRESULT)0x88890004)
#endif
#ifndef ENDPOINT_HARDWARE_SUPPORT_VOLUME
#define ENDPOINT_HARDWARE_SUPPORT_VOLUME 0x00000001
#endif

static std::mutex g_outMtx;

static std::string wideToUtf8(const wchar_t* w, int len = -1) {
  if (!w || (len == 0)) return {};
  int need = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr);
  if (need <= 0) return {};
  std::string s(need, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, len, s.data(), need, nullptr, nullptr);
  if (len < 0 && !s.empty() && s.back() == '\0') s.pop_back();
  return s;
}

static std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  int need = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  if (need <= 0) return {};
  std::wstring w(need, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), need);
  return w;
}

static std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
          out += buf;
        } else {
          out.push_back((char)c);
        }
    }
  }
  return out;
}

static void emitLine(const std::string& line) {
  std::lock_guard<std::mutex> lk(g_outMtx);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

static std::string toLowerAscii(std::string s) {
  for (char& ch : s) ch = (char)std::tolower((unsigned char)ch);
  return s;
}

static bool containsIgnoreCase(const std::string& hay, const char* needle) {
  return toLowerAscii(hay).find(toLowerAscii(needle)) != std::string::npos;
}

/* ---------------- 极简安全 JSON 解析器（仅覆盖命令行对象） ---------------- */
struct JVal {
  enum Type { Null, Bool, Num, Str, Obj } type = Null;
  bool b = false;
  double num = 0.0;
  std::string str;
  std::map<std::string, JVal> obj;

  const JVal* get(const char* k) const {
    if (type != Obj) return nullptr;
    auto it = obj.find(k);
    return it == obj.end() ? nullptr : &it->second;
  }
  std::string getStr(const char* k, const std::string& fb = "") const {
    const JVal* v = get(k);
    return (v && v->type == Str) ? v->str : fb;
  }
  double getNum(const char* k, double fb = 0.0) const {
    const JVal* v = get(k);
    return (v && v->type == Num) ? v->num : fb;
  }
  int64_t getInt(const char* k, int64_t fb = 0) const {
    const JVal* v = get(k);
    return (v && v->type == Num) ? (int64_t)v->num : fb;
  }
  bool getBool(const char* k, bool fb = false) const {
    const JVal* v = get(k);
    return (v && v->type == Bool) ? v->b : fb;
  }
};

class JParser {
  const std::string& src_;
  size_t pos_ = 0;

  void skipWs() {
    while (pos_ < src_.size() && (unsigned char)src_[pos_] <= ' ') pos_++;
  }
  static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp <= 0x7F) {
      out.push_back((char)cp);
    } else if (cp <= 0x7FF) {
      out.push_back((char)(0xC0 | (cp >> 6)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
      out.push_back((char)(0xE0 | (cp >> 12)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
      out.push_back((char)(0xF0 | (cp >> 18)));
      out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    }
  }
  bool parseHex4(uint32_t& val) {
    if (pos_ + 4 > src_.size()) return false;
    val = 0;
    for (int i = 0; i < 4; i++) {
      char c = src_[pos_++];
      val <<= 4;
      if (c >= '0' && c <= '9') val |= (uint32_t)(c - '0');
      else if (c >= 'a' && c <= 'f') val |= (uint32_t)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') val |= (uint32_t)(c - 'A' + 10);
      else return false;
    }
    return true;
  }
  bool parseStr(std::string& out) {
    if (pos_ >= src_.size() || src_[pos_] != '"') return false;
    pos_++;
    out.clear();
    while (pos_ < src_.size()) {
      char c = src_[pos_++];
      if (c == '"') return true;
      if (c == '\\') {
        if (pos_ >= src_.size()) return false;
        char e = src_[pos_++];
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            uint32_t cp = 0;
            if (!parseHex4(cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 2 <= src_.size() && src_[pos_] == '\\' && src_[pos_ + 1] == 'u') {
              pos_ += 2;
              uint32_t lo = 0;
              if (parseHex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + (((cp - 0xD800) << 10) | (lo - 0xDC00));
              }
            }
            appendUtf8(out, cp);
            break;
          }
          default: out.push_back(e); break;
        }
      } else {
        out.push_back(c);
      }
    }
    return false;
  }

public:
  explicit JParser(const std::string& s) : src_(s) {}

  bool parseValue(JVal& out, int depth = 0) {
    if (depth > 16) return false;
    skipWs();
    if (pos_ >= src_.size()) return false;
    char c = src_[pos_];
    if (c == '"') {
      out = JVal{};
      out.type = JVal::Str;
      return parseStr(out.str);
    }
    if (c == '{') {
      pos_++;
      out = JVal{};
      out.type = JVal::Obj;
      skipWs();
      if (pos_ < src_.size() && src_[pos_] == '}') { pos_++; return true; }
      while (pos_ < src_.size()) {
        skipWs();
        std::string key;
        if (!parseStr(key)) return false;
        skipWs();
        if (pos_ >= src_.size() || src_[pos_] != ':') return false;
        pos_++;
        JVal val;
        if (!parseValue(val, depth + 1)) return false;
        out.obj.emplace(std::move(key), std::move(val));
        skipWs();
        if (pos_ >= src_.size()) return false;
        if (src_[pos_] == '}') { pos_++; return true; }
        if (src_[pos_] != ',') return false;
        pos_++;
      }
      return false;
    }
    if (c == 't' && src_.compare(pos_, 4, "true") == 0) {
      pos_ += 4;
      out = JVal{};
      out.type = JVal::Bool;
      out.b = true;
      return true;
    }
    if (c == 'f' && src_.compare(pos_, 5, "false") == 0) {
      pos_ += 5;
      out = JVal{};
      out.type = JVal::Bool;
      out.b = false;
      return true;
    }
    if (c == 'n' && src_.compare(pos_, 4, "null") == 0) {
      pos_ += 4;
      out = JVal{};
      out.type = JVal::Null;
      return true;
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
      const char* start = src_.c_str() + pos_;
      char* end = nullptr;
      double d = std::strtod(start, &end);
      if (end == start) return false;
      pos_ = (size_t)(end - src_.c_str());
      out = JVal{};
      out.type = JVal::Num;
      out.num = d;
      return true;
    }
    return false;
  }
};

/* ---------------- COM 简单智能指针 ---------------- */
template <typename T>
struct ComPtr {
  T* p = nullptr;
  ComPtr() = default;
  ~ComPtr() { reset(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  ComPtr(ComPtr&& o) noexcept : p(o.p) { o.p = nullptr; }
  ComPtr& operator=(ComPtr&& o) noexcept {
    if (this != &o) { reset(); p = o.p; o.p = nullptr; }
    return *this;
  }
  void reset(T* np = nullptr) {
    if (p) p->Release();
    p = np;
  }
  T** put() { reset(); return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

/* ---------------- 本地解码器抽象 ---------------- */
struct SourceFormat {
  uint32_t sampleRate = 44100;
  uint16_t channels = 2;
  uint16_t bitsPerSample = 16;
  bool isFloat = false;
  bool isLossy = false;
  double duration = 0.0;
};

class AudioDecoder {
public:
  virtual ~AudioDecoder() = default;
  virtual const SourceFormat& format() const = 0;
  virtual bool readFrames(uint32_t maxFrames, std::vector<uint8_t>& outBytes, uint32_t& outFrames, bool& eof) = 0;
  virtual bool seek(double sec, double& actualSec) = 0;
};

/* --- 1) 内置无损 WAV 直解器（16/24/32-bit PCM & 32/64-bit IEEE Float） --- */
class WavDecoder final : public AudioDecoder {
  FILE* fp_ = nullptr;
  SourceFormat fmt_{};
  uint64_t dataOffset_ = 0;
  uint64_t dataSize_ = 0;
  uint64_t readOffset_ = 0;
  uint32_t blockAlign_ = 0;
  bool is64Float_ = false;

  static uint16_t rd16(const uint8_t* p) { return (uint16_t)p[0] | ((uint16_t)p[1] << 8); }
  static uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
  }

public:
  ~WavDecoder() override {
    if (fp_) std::fclose(fp_);
  }

  bool open(const std::wstring& wpath) {
    fp_ = _wfopen(wpath.c_str(), L"rb");
    if (!fp_) return false;
    uint8_t riff[12]{};
    if (std::fread(riff, 1, 12, fp_) != 12) return false;
    if (std::memcmp(riff, "RIFF", 4) != 0 || std::memcmp(riff + 8, "WAVE", 4) != 0) return false;

    bool gotFmt = false, gotData = false;
    uint16_t audioTag = 0;
    uint16_t validBits = 0;

    while (!gotFmt || !gotData) {
      uint8_t ch[8]{};
      if (std::fread(ch, 1, 8, fp_) != 8) break;
      uint32_t sz = rd32(ch + 4);
      uint64_t bodyPos = (uint64_t)_ftelli64(fp_);
      uint64_t nextPos = bodyPos + sz + (sz & 1u);

      if (std::memcmp(ch, "fmt ", 4) == 0 && sz >= 16) {
        std::vector<uint8_t> buf(sz);
        if (std::fread(buf.data(), 1, sz, fp_) != sz) return false;
        audioTag = rd16(buf.data());
        fmt_.channels = rd16(buf.data() + 2);
        fmt_.sampleRate = rd32(buf.data() + 4);
        blockAlign_ = rd16(buf.data() + 12);
        uint16_t bps = rd16(buf.data() + 14);
        if (audioTag == 0xFFFE && sz >= 40) {
          validBits = rd16(buf.data() + 18);
          uint32_t sub = rd32(buf.data() + 24);
          if (sub == 1) audioTag = 1;
          else if (sub == 3) audioTag = 3;
        }
        if ((audioTag != 1 && audioTag != 3) || fmt_.channels == 0 || fmt_.sampleRate == 0 || blockAlign_ == 0) {
          return false;
        }
        if (audioTag == 3 && bps == 64) {
          is64Float_ = true;
          fmt_.isFloat = true;
          fmt_.bitsPerSample = 32;
        } else {
          fmt_.isFloat = (audioTag == 3);
          fmt_.bitsPerSample = bps;
        }
        if (fmt_.bitsPerSample != 16 && fmt_.bitsPerSample != 24 && fmt_.bitsPerSample != 32) return false;
        if (blockAlign_ != (uint32_t)fmt_.channels * (bps / 8)) return false;
        gotFmt = true;
      } else if (std::memcmp(ch, "data", 4) == 0) {
        dataOffset_ = bodyPos;
        dataSize_ = sz;
        gotData = true;
      }
      if (_fseeki64(fp_, (long long)nextPos, SEEK_SET) != 0) break;
    }

    if (!gotFmt || !gotData) return false;
    uint64_t totalFrames = dataSize_ / blockAlign_;
    fmt_.duration = fmt_.sampleRate ? (double)totalFrames / (double)fmt_.sampleRate : 0.0;
    fmt_.isLossy = false;
    readOffset_ = 0;
    _fseeki64(fp_, (long long)dataOffset_, SEEK_SET);
    return true;
  }

  const SourceFormat& format() const override { return fmt_; }

  bool readFrames(uint32_t maxFrames, std::vector<uint8_t>& outBytes, uint32_t& outFrames, bool& eof) override {
    outFrames = 0;
    if (readOffset_ >= dataSize_) {
      eof = true;
      outBytes.clear();
      return true;
    }
    uint64_t remainBytes = dataSize_ - readOffset_;
    uint64_t wantBytes = (uint64_t)maxFrames * blockAlign_;
    uint64_t toRead = std::min(remainBytes, wantBytes);
    toRead -= (toRead % blockAlign_);
    if (toRead == 0) {
      eof = true;
      outBytes.clear();
      return true;
    }
    if (!is64Float_) {
      outBytes.resize((size_t)toRead);
      size_t got = std::fread(outBytes.data(), 1, (size_t)toRead, fp_);
      got -= (got % blockAlign_);
      outBytes.resize(got);
      readOffset_ += got;
      outFrames = (uint32_t)(got / blockAlign_);
      eof = (readOffset_ >= dataSize_);
      return true;
    }
    std::vector<double> tmp((size_t)(toRead / 8));
    size_t got = std::fread(tmp.data(), 1, (size_t)toRead, fp_);
    got -= (got % blockAlign_);
    uint32_t frames = (uint32_t)(got / blockAlign_);
    size_t samples = (size_t)frames * fmt_.channels;
    outBytes.resize(samples * 4);
    float* dst = reinterpret_cast<float*>(outBytes.data());
    for (size_t i = 0; i < samples; i++) dst[i] = (float)tmp[i];
    readOffset_ += got;
    outFrames = frames;
    eof = (readOffset_ >= dataSize_);
    return true;
  }

  bool seek(double sec, double& actualSec) override {
    if (!fp_ || blockAlign_ == 0) return false;
    if (sec < 0.0) sec = 0.0;
    uint64_t frame = (uint64_t)std::llround(sec * (double)fmt_.sampleRate);
    uint64_t byteOff = frame * blockAlign_;
    if (byteOff > dataSize_) {
      byteOff = dataSize_ - (dataSize_ % blockAlign_);
      frame = byteOff / blockAlign_;
    }
    if (_fseeki64(fp_, (long long)(dataOffset_ + byteOff), SEEK_SET) != 0) return false;
    readOffset_ = byteOff;
    actualSec = fmt_.sampleRate ? (double)frame / (double)fmt_.sampleRate : 0.0;
    return true;
  }
};

/* --- 2) Windows Media Foundation 解码器（FLAC / ALAC / M4A / MP3 / AAC / WMA） --- */
class MfDecoder final : public AudioDecoder {
  ComPtr<IMFSourceReader> reader_;
  SourceFormat fmt_{};
  uint32_t srcBlockAlign_ = 0;
  std::vector<uint8_t> leftover_;
  size_t leftoverPos_ = 0;

public:
  bool open(const std::wstring& wpath, const std::string& extLower, std::string& errMsg) {
    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(attrs.put(), 1);
    if (attrs) attrs->SetUINT32(MF_LOW_LATENCY, FALSE);

    HRESULT hr = MFCreateSourceReaderFromURL(wpath.c_str(), attrs.p, reader_.put());
    if (FAILED(hr) || !reader_) {
      errMsg = "无法解析该音频文件或缺少系统解码器";
      return false;
    }

    reader_->SetStreamSelection((DWORD)MF_SOURCE_READER_ALL_STREAMS, FALSE);
    hr = reader_->SetStreamSelection((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE);
    if (FAILED(hr)) {
      errMsg = "文件中未包含可解码的音频流";
      return false;
    }

    ComPtr<IMFMediaType> nativeType;
    hr = reader_->GetNativeMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, nativeType.put());
    if (FAILED(hr) || !nativeType) {
      errMsg = "无法读取音频流原始格式";
      return false;
    }

    UINT32 rate = 0, ch = 0, bps = 0;
    nativeType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate);
    nativeType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &ch);
    nativeType->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bps);
    if (rate == 0) rate = 44100;
    if (ch == 0) ch = 2;

    GUID subType = GUID_NULL;
    nativeType->GetGUID(MF_MT_SUBTYPE, &subType);

    // 精确识别有损/无损编码（覆盖在线流缺扩展名或 M4A 封装 AAC vs ALAC 的场景）
    static const GUID kSubFlac = { 0x0000F1AC, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 } };
    static const GUID kSubAlac = { 0x63616C61, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 } };
    bool isKnownLosslessSub = (subType == MFAudioFormat_PCM) || (subType == MFAudioFormat_Float) ||
                              (subType == kSubFlac) || (subType == kSubAlac);
    bool isKnownLossySub = (subType == MFAudioFormat_MP3) || (subType == MFAudioFormat_AAC) ||
                           (subType == MFAudioFormat_MPEG) || (subType == MFAudioFormat_WMAudioV8) ||
                           (subType == MFAudioFormat_WMAudioV9) || (subType == MFAudioFormat_Opus);
    bool isLossyExt = (extLower == ".mp3" || extLower == ".aac" || extLower == ".ogg" ||
                       extLower == ".opus" || extLower == ".wma" || extLower == ".m4s");
    bool isLossy = isKnownLossySub ? true : (isKnownLosslessSub ? false : (isLossyExt || extLower == ".m4a" || extLower == ".mp4"));
    bool preferFloat = isLossy || (subType == MFAudioFormat_Float) || (bps == 0);

    ComPtr<IMFMediaType> outType;
    MFCreateMediaType(outType.put());
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate);
    outType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, ch);

    if (preferFloat) {
      outType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
      outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
      hr = reader_->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outType.p);
      if (FAILED(hr)) {
        outType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
        outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        hr = reader_->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outType.p);
      }
    } else {
      UINT32 targetBps = (bps == 24 || bps == 32) ? bps : 16;
      outType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
      outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, targetBps);
      hr = reader_->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outType.p);
      if (FAILED(hr) && targetBps == 24) {
        outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
        hr = reader_->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outType.p);
      }
      if (FAILED(hr)) {
        outType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
        outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
        hr = reader_->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outType.p);
      }
    }

    if (FAILED(hr)) {
      errMsg = "当前独占引擎暂不支持该编码格式";
      return false;
    }

    ComPtr<IMFMediaType> actualType;
    reader_->GetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, actualType.put());
    UINT32 aRate = rate, aCh = ch, aBps = 16;
    GUID aSub = MFAudioFormat_PCM;
    if (actualType) {
      actualType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &aRate);
      actualType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &aCh);
      actualType->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &aBps);
      actualType->GetGUID(MF_MT_SUBTYPE, &aSub);
    }

    fmt_.sampleRate = aRate ? aRate : rate;
    fmt_.channels = (uint16_t)(aCh ? aCh : ch);
    fmt_.bitsPerSample = (uint16_t)(aBps ? aBps : 16);
    fmt_.isFloat = (aSub == MFAudioFormat_Float);
    fmt_.isLossy = isLossy;
    srcBlockAlign_ = fmt_.channels * (fmt_.bitsPerSample / 8);

    PROPVARIANT var;
    PropVariantInit(&var);
    if (SUCCEEDED(reader_->GetPresentationAttribute((DWORD)MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &var))) {
      if (var.vt == VT_UI8) fmt_.duration = (double)var.uhVal.QuadPart / 10000000.0;
      else if (var.vt == VT_I8) fmt_.duration = (double)var.hVal.QuadPart / 10000000.0;
    }
    PropVariantClear(&var);
    return srcBlockAlign_ > 0;
  }

  const SourceFormat& format() const override { return fmt_; }

  bool readFrames(uint32_t maxFrames, std::vector<uint8_t>& outBytes, uint32_t& outFrames, bool& eof) override {
    outBytes.clear();
    outFrames = 0;
    eof = false;
    const size_t wantBytes = (size_t)maxFrames * srcBlockAlign_;

    while (outBytes.size() < wantBytes) {
      if (leftoverPos_ < leftover_.size()) {
        size_t take = std::min(wantBytes - outBytes.size(), leftover_.size() - leftoverPos_);
        outBytes.insert(outBytes.end(), leftover_.begin() + (ptrdiff_t)leftoverPos_,
                        leftover_.begin() + (ptrdiff_t)(leftoverPos_ + take));
        leftoverPos_ += take;
        if (leftoverPos_ >= leftover_.size()) {
          leftover_.clear();
          leftoverPos_ = 0;
        }
        continue;
      }

      DWORD streamIdx = 0, flags = 0;
      LONGLONG ts = 0;
      ComPtr<IMFSample> sample;
      HRESULT hr = reader_->ReadSample((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, &streamIdx, &flags, &ts, sample.put());
      if (FAILED(hr)) return false;
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
        eof = true;
        break;
      }
      if (!sample) continue;

      ComPtr<IMFMediaBuffer> buf;
      if (FAILED(sample->ConvertToContiguousBuffer(buf.put())) || !buf) continue;
      BYTE* data = nullptr;
      DWORD curLen = 0;
      if (SUCCEEDED(buf->Lock(&data, nullptr, &curLen)) && data && curLen > 0) {
        leftover_.assign(data, data + curLen);
        leftoverPos_ = 0;
        buf->Unlock();
      }
    }

    size_t aligned = outBytes.size() - (outBytes.size() % srcBlockAlign_);
    outBytes.resize(aligned);
    outFrames = (uint32_t)(aligned / srcBlockAlign_);
    return true;
  }

  bool seek(double sec, double& actualSec) override {
    if (!reader_) return false;
    if (sec < 0.0) sec = 0.0;
    leftover_.clear();
    leftoverPos_ = 0;
    PROPVARIANT var;
    PropVariantInit(&var);
    var.vt = VT_I8;
    var.hVal.QuadPart = (LONGLONG)std::llround(sec * 10000000.0);
    HRESULT hr = reader_->SetCurrentPosition(GUID_NULL, var);
    PropVariantClear(&var);
    if (FAILED(hr)) return false;
    if (sec <= 0.001) {
      actualSec = 0.0;
      return true;
    }

    // 读取并按采样点裁剪 MF seek pre-roll，校准真实位置避免 FLAC/MP3 歌词时间错位
    size_t skipRemaining = 0;
    bool skipCalibrated = false;
    actualSec = sec;
    for (int probe = 0; probe < 64; probe++) {
      DWORD streamIdx = 0, flags = 0;
      LONGLONG ts = -1;
      ComPtr<IMFSample> sample;
      hr = reader_->ReadSample((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, &streamIdx, &flags, &ts, sample.put());
      if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) break;
      if (!sample) continue;
      ComPtr<IMFMediaBuffer> buf;
      if (FAILED(sample->ConvertToContiguousBuffer(buf.put())) || !buf) continue;
      BYTE* data = nullptr;
      DWORD curLen = 0;
      if (FAILED(buf->Lock(&data, nullptr, &curLen)) || !data || curLen == 0) {
        if (data) buf->Unlock();
        continue;
      }
      size_t aligned = (size_t)curLen - ((size_t)curLen % srcBlockAlign_);
      if (!skipCalibrated) {
        skipCalibrated = true;
        double sampleSec = (ts >= 0) ? ((double)ts / 10000000.0) : -1.0;
        if (sampleSec >= 0.0 && sec > sampleSec && (sec - sampleSec) < 20.0) {
          uint64_t skipFrames = (uint64_t)std::llround((sec - sampleSec) * (double)fmt_.sampleRate);
          skipRemaining = (size_t)skipFrames * srcBlockAlign_;
          actualSec = sec;
        } else if (sampleSec >= 0.0) {
          actualSec = sampleSec;
        }
      }
      if (skipRemaining >= aligned) {
        skipRemaining -= aligned;
        buf->Unlock();
        continue;
      }
      leftover_.assign(data + skipRemaining, data + aligned);
      leftoverPos_ = 0;
      skipRemaining = 0;
      buf->Unlock();
      break;
    }
    return true;
  }
};

/* ---------------- WASAPI 格式构造与样本转换 ---------------- */
struct HwFormat {
  WAVEFORMATEXTENSIBLE wfx{};
  uint32_t sampleRate = 44100;
  uint16_t channels = 2;
  uint16_t containerBits = 16;
  uint16_t validBits = 16;
  bool isFloat = false;
};

static DWORD defaultChannelMask(uint16_t ch) {
  switch (ch) {
    case 1: return SPEAKER_FRONT_CENTER;
    case 2: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    case 4: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
    case 6: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
    case 8: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT;
    default: return 0;
  }
}

static HwFormat makeHwFormat(uint32_t rate, uint16_t ch, uint16_t containerBits, uint16_t validBits, bool isFloat) {
  HwFormat f;
  f.sampleRate = rate;
  f.channels = ch;
  f.containerBits = containerBits;
  f.validBits = validBits;
  f.isFloat = isFloat;

  WAVEFORMATEX& wf = f.wfx.Format;
  wf.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  wf.nChannels = ch;
  wf.nSamplesPerSec = rate;
  wf.wBitsPerSample = containerBits;
  wf.nBlockAlign = (WORD)(ch * (containerBits / 8));
  wf.nAvgBytesPerSec = rate * wf.nBlockAlign;
  wf.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);

  f.wfx.Samples.wValidBitsPerSample = validBits;
  f.wfx.dwChannelMask = defaultChannelMask(ch);
  f.wfx.SubFormat = isFloat ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
  return f;
}

static void convertSamples(const uint8_t* src, const SourceFormat& sf,
                           uint8_t* dst, const HwFormat& hf,
                           uint32_t frames, double& curGain, double targetGain, double rampStep) {
  const size_t ch = sf.channels;
  const uint32_t srcStride = sf.bitsPerSample / 8;
  const uint32_t dstStride = hf.containerBits / 8;

  // 快速无失真整数直通：当前与目标增益均满格且整数格式匹配时直接比特搬运，不触碰采样值
  if (curGain >= 0.9999 && targetGain >= 0.9999 && !sf.isFloat && !hf.isFloat) {
    curGain = 1.0;
    const size_t total = (size_t)frames * ch;
    if (sf.bitsPerSample == 16 && hf.containerBits == 16) {
      std::memcpy(dst, src, total * 2);
      return;
    }
    if (sf.bitsPerSample == 24 && hf.containerBits == 24) {
      std::memcpy(dst, src, total * 3);
      return;
    }
    if (sf.bitsPerSample == 32 && hf.containerBits == 32) {
      std::memcpy(dst, src, total * 4);
      return;
    }
    if ((sf.bitsPerSample == 24 || sf.bitsPerSample == 16) && hf.containerBits == 32) {
      for (size_t i = 0; i < total; i++) {
        const uint8_t* sp = src + i * srcStride;
        uint8_t* dp = dst + i * dstStride;
        if (sf.bitsPerSample == 24) {
          dp[0] = 0;
          dp[1] = sp[0];
          dp[2] = sp[1];
          dp[3] = sp[2];
        } else {
          dp[0] = 0;
          dp[1] = 0;
          dp[2] = sp[0];
          dp[3] = sp[1];
        }
      }
      return;
    }
  }

  for (uint32_t f = 0; f < frames; f++) {
    // 按帧平滑斜坡跟踪目标增益（约 15ms），同一帧各声道使用同一增益保持声像对齐
    if (std::abs(targetGain - curGain) <= rampStep) {
      curGain = targetGain;
    } else if (targetGain > curGain) {
      curGain += rampStep;
    } else {
      curGain -= rampStep;
    }
    const double g = curGain;

    for (size_t c = 0; c < ch; c++) {
      const size_t i = (size_t)f * ch + c;
      double norm = 0.0; // 归一化至 [-1.0, 1.0)
      const uint8_t* sp = src + i * srcStride;
      if (sf.isFloat) {
        float fv = 0.0f;
        std::memcpy(&fv, sp, sizeof(float));
        norm = (double)fv;
      } else if (sf.bitsPerSample == 16) {
        int16_t v = 0;
        std::memcpy(&v, sp, 2);
        norm = (double)v / 32768.0;
      } else if (sf.bitsPerSample == 24) {
        int32_t v = (int32_t)((uint32_t)sp[0] | ((uint32_t)sp[1] << 8) | ((uint32_t)sp[2] << 16));
        if (v & 0x800000) v |= ~0xFFFFFF;
        norm = (double)v / 8388608.0;
      } else {
        int32_t v = 0;
        std::memcpy(&v, sp, 4);
        norm = (double)v / 2147483648.0;
      }

      norm *= g;
      if (norm > 0.9999999) norm = 0.9999999;
      else if (norm < -1.0) norm = -1.0;

      uint8_t* dp = dst + i * dstStride;
      if (hf.isFloat) {
        float fv = (float)norm;
        std::memcpy(dp, &fv, 4);
      } else if (hf.containerBits == 16) {
        int32_t iv = (int32_t)std::llround(norm * 32767.0);
        iv = std::clamp(iv, -32768, 32767);
        int16_t s16 = (int16_t)iv;
        std::memcpy(dp, &s16, 2);
      } else if (hf.containerBits == 24) {
        int32_t iv = (int32_t)std::llround(norm * 8388607.0);
        iv = std::clamp(iv, -8388608, 8388607);
        dp[0] = (uint8_t)(iv & 0xFF);
        dp[1] = (uint8_t)((iv >> 8) & 0xFF);
        dp[2] = (uint8_t)((iv >> 16) & 0xFF);
      } else if (hf.containerBits == 32 && hf.validBits == 24) {
        int32_t iv = (int32_t)std::llround(norm * 8388607.0);
        iv = std::clamp(iv, -8388608, 8388607);
        int32_t packed = iv << 8;
        std::memcpy(dp, &packed, 4);
      } else {
        int64_t iv = std::llround(norm * 2147483647.0);
        iv = std::clamp<int64_t>(iv, INT32_MIN, INT32_MAX);
        int32_t s32 = (int32_t)iv;
        std::memcpy(dp, &s32, 4);
      }
    }
  }
}

/* ---------------- 热插拔通知监听器 ---------------- */
class AudioEngine;
static AudioEngine* g_engine = nullptr;

class NotificationClient final : public IMMNotificationClient {
  std::atomic<ULONG> ref_{1};
public:
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *ppv = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR pwstrDeviceId, DWORD dwNewState) override;
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override;
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR pwstrDeviceId) override;
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole, LPCWSTR) override;
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};

/* ---------------- 核心独占音频引擎 ---------------- */
class AudioEngine {
  ComPtr<IMMDeviceEnumerator> enumerator_;
  NotificationClient* notify_ = nullptr;

  std::mutex ctrlMtx_;
  std::thread renderThread_;
  std::atomic<bool> stopThread_{false};
  std::atomic<bool> playing_{false};
  std::atomic<bool> deviceLostFlag_{false};

  struct QueuedTrack {
    std::string trackId;
    std::unique_ptr<AudioDecoder> decoder;
    std::vector<uint8_t> warmPcm;
    uint32_t warmFrames = 0;
    uint32_t warmPos = 0;
    bool warmEof = false;
  };

  std::unique_ptr<AudioDecoder> decoder_;
  mutable std::mutex decInfoMtx_;
  SourceFormat curSrcFmt_{};
  bool hasCurSrcFmt_ = false;
  std::vector<uint8_t> curWarmPcm_;
  uint32_t curWarmFrames_ = 0;
  uint32_t curWarmPos_ = 0;
  bool curWarmEof_ = false;

  std::mutex nextMtx_;
  std::unique_ptr<QueuedTrack> nextTrack_;

  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioRenderClient> renderClient_;
  ComPtr<IAudioClock> clock_;
  ComPtr<IAudioEndpointVolume> epVol_;
  HANDLE eventHandle_ = nullptr;

  std::string activeDeviceId_;
  HwFormat hwFmt_{};
  UINT32 bufferFrames_ = 0;
  bool eventDriven_ = true;
  bool hwVolSupported_ = false;
  std::atomic<double> volume_{0.78};
  std::atomic<bool> muted_{false};
  double curGain_ = 1.0;
  double posAnchorSec_ = 0.0;
  std::atomic<uint64_t> decodedFramesWritten_{0};
  std::atomic<LONGLONG> lastWriteQpc_{0};
  LONGLONG qpcFreq_ = 0;
  std::atomic<bool> streamStarted_{false};
  bool preRollDone_ = false;
  UINT64 clockFreq_ = 0;
  bool endedState_ = false;

  std::string propStr(IPropertyStore* store, const PROPERTYKEY& key) {
    if (!store) return {};
    PROPVARIANT pv;
    PropVariantInit(&pv);
    std::string res;
    if (SUCCEEDED(store->GetValue(key, &pv)) && pv.vt == VT_LPWSTR && pv.pwszVal) {
      res = wideToUtf8(pv.pwszVal);
    }
    PropVariantClear(&pv);
    return res;
  }

  void releaseSessionLocked() {
    stopThread_ = true;
    if (eventHandle_) SetEvent(eventHandle_);
    if (renderThread_.joinable()) {
      ctrlMtx_.unlock();
      renderThread_.join();
      ctrlMtx_.lock();
    }
    if (client_) {
      try { client_->Stop(); } catch (...) {}
    }
    epVol_.reset();
    clock_.reset();
    renderClient_.reset();
    client_.reset();
    device_.reset();
    decoder_.reset();
    {
      std::lock_guard<std::mutex> dlk(decInfoMtx_);
      curSrcFmt_ = SourceFormat{};
      hasCurSrcFmt_ = false;
    }
    curWarmPcm_.clear();
    curWarmFrames_ = 0;
    curWarmPos_ = 0;
    curWarmEof_ = false;
    {
      std::lock_guard<std::mutex> nlk(nextMtx_);
      nextTrack_.reset();
    }
    if (eventHandle_) {
      CloseHandle(eventHandle_);
      eventHandle_ = nullptr;
    }
    activeDeviceId_.clear();
    playing_ = false;
    endedState_ = false;
    posAnchorSec_ = 0.0;
    decodedFramesWritten_ = 0;
    lastWriteQpc_ = 0;
    streamStarted_ = false;
    preRollDone_ = false;
    clockFreq_ = 0;
    deviceLostFlag_ = false;
  }

  bool isBitPerfectFor(const SourceFormat& sf) const {
    return !sf.isLossy && hwFmt_.sampleRate == sf.sampleRate && hwFmt_.validBits >= sf.bitsPerSample
        && !muted_.load() && volume_.load() >= 0.999;
  }

  bool isBitPerfectNow() const {
    SourceFormat sf{};
    {
      std::lock_guard<std::mutex> dlk(decInfoMtx_);
      if (!hasCurSrcFmt_) return false;
      sf = curSrcFmt_;
    }
    return isBitPerfectFor(sf);
  }

  double currentDurationSafe() const {
    std::lock_guard<std::mutex> dlk(decInfoMtx_);
    return hasCurSrcFmt_ ? curSrcFmt_.duration : 0.0;
  }

  static bool openDecoderForPath(const std::string& filePath, std::unique_ptr<AudioDecoder>& outDec, std::string& errMsg) {
    outDec.reset();
    std::wstring wpath = utf8ToWide(filePath);
    std::string lowerPath = toLowerAscii(filePath);
    bool isHttpUrl = (lowerPath.rfind("http://", 0) == 0 || lowerPath.rfind("https://", 0) == 0);
    std::string cleanPath = filePath;
    size_t qPos = cleanPath.find_first_of("?#");
    if (qPos != std::string::npos) cleanPath = cleanPath.substr(0, qPos);
    std::string ext;
    size_t dot = cleanPath.find_last_of('.');
    if (dot != std::string::npos) ext = toLowerAscii(cleanPath.substr(dot));

    if (!isHttpUrl && ext == ".wav") {
      auto wd = std::make_unique<WavDecoder>();
      if (wd->open(wpath)) {
        outDec = std::move(wd);
        return true;
      }
    }
    auto md = std::make_unique<MfDecoder>();
    if (!md->open(wpath, ext, errMsg)) return false;
    outDec = std::move(md);
    return true;
  }

  bool readCurrentFrames(uint32_t maxFrames, std::vector<uint8_t>& outBytes, uint32_t& outFrames, bool& eof) {
    outBytes.clear();
    outFrames = 0;
    eof = false;
    if (!decoder_) { eof = true; return true; }
    const SourceFormat& sf = decoder_->format();
    const size_t srcFrameBytes = (size_t)sf.channels * (sf.bitsPerSample / 8);

    if (curWarmPos_ < curWarmFrames_ && srcFrameBytes > 0) {
      uint32_t take = std::min(maxFrames, curWarmFrames_ - curWarmPos_);
      size_t byteOff = (size_t)curWarmPos_ * srcFrameBytes;
      size_t byteLen = (size_t)take * srcFrameBytes;
      if (byteOff + byteLen <= curWarmPcm_.size()) {
        outBytes.assign(curWarmPcm_.begin() + (ptrdiff_t)byteOff,
                        curWarmPcm_.begin() + (ptrdiff_t)(byteOff + byteLen));
        outFrames = take;
      }
      curWarmPos_ += take;
      if (curWarmPos_ >= curWarmFrames_) {
        curWarmPcm_.clear();
        curWarmFrames_ = 0;
        curWarmPos_ = 0;
        if (curWarmEof_) {
          curWarmEof_ = false;
          eof = true;
          return true;
        }
      }
      if (outFrames >= maxFrames) return true;
    }

    uint32_t rem = maxFrames - outFrames;
    std::vector<uint8_t> more;
    uint32_t moreFrames = 0;
    bool moreEof = false;
    if (!decoder_->readFrames(rem, more, moreFrames, moreEof)) {
      if (outFrames > 0) return true;
      return false;
    }
    if (moreFrames > 0 && !more.empty()) {
      outBytes.insert(outBytes.end(), more.begin(), more.end());
      outFrames += moreFrames;
    }
    eof = moreEof;
    return true;
  }

  const char* currentVolumeMode() const {
    return (!muted_.load() && volume_.load() >= 0.999) ? "bypass" : "software";
  }

  bool initWasapiSession(const std::string& reqDeviceId, const SourceFormat& sf,
                         std::string& errCode, std::string& errMsg) {
    HRESULT hr = S_OK;
    if (reqDeviceId.empty()) {
      hr = enumerator_->GetDefaultAudioEndpoint(eRender, eConsole, device_.put());
    } else {
      std::wstring wid = utf8ToWide(reqDeviceId);
      hr = enumerator_->GetDevice(wid.c_str(), device_.put());
    }
    if (FAILED(hr) || !device_) {
      errCode = "DEVICE_NOT_FOUND";
      errMsg = "找不到指定的音频输出设备";
      return false;
    }

    LPWSTR realIdW = nullptr;
    if (SUCCEEDED(device_->GetId(&realIdW)) && realIdW) {
      activeDeviceId_ = wideToUtf8(realIdW);
      CoTaskMemFree(realIdW);
    }

    hr = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client_.put());
    if (FAILED(hr) || !client_) {
      errCode = "AUDIO_CLIENT_FAILED";
      errMsg = "无法激活音频设备端点";
      return false;
    }

    std::vector<HwFormat> candidates;
    if (sf.isFloat) {
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, true));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 24, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 16, 16, false));
    } else if (sf.bitsPerSample == 16) {
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 16, 16, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 24, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, true));
    } else if (sf.bitsPerSample == 24) {
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 24, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 24, 24, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, true));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 16, 16, false));
    } else {
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 24, false));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 32, 32, true));
      candidates.push_back(makeHwFormat(sf.sampleRate, sf.channels, 16, 16, false));
    }

    bool matched = false;
    for (const auto& cand : candidates) {
      HRESULT sfHr = client_->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                                reinterpret_cast<const WAVEFORMATEX*>(&cand.wfx), nullptr);
      if (sfHr == S_OK) {
        hwFmt_ = cand;
        matched = true;
        break;
      }
      if (sfHr == AUDCLNT_E_DEVICE_IN_USE) {
        errCode = "DEVICE_IN_USE";
        errMsg = "该输出设备正被其他程序占用，无法启用独占模式";
        return false;
      }
    }
    if (!matched) {
      errCode = "FORMAT_UNSUPPORTED";
      errMsg = "当前输出设备不支持 " + std::to_string(sf.sampleRate) + " Hz 独占输出";
      return false;
    }

    REFERENCE_TIME defPeriod = 100000, minPeriod = 30000;
    client_->GetDevicePeriod(&defPeriod, &minPeriod);
    if (defPeriod <= 0) defPeriod = 100000;

    const WAVEFORMATEX* wfxPtr = reinterpret_cast<const WAVEFORMATEX*>(&hwFmt_.wfx);
    eventDriven_ = true;
    hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                             defPeriod, defPeriod, wfxPtr, nullptr);
    if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
      UINT32 frames = 0;
      if (SUCCEEDED(client_->GetBufferSize(&frames)) && frames > 0) {
        REFERENCE_TIME alignedHns = (REFERENCE_TIME)((10000000.0 * (double)frames / (double)hwFmt_.sampleRate) + 0.5);
        client_.reset();
        hr = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client_.put());
        if (SUCCEEDED(hr) && client_) {
          hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                   alignedHns, alignedHns, wfxPtr, nullptr);
        }
      }
    }

    if (hr == AUDCLNT_E_DEVICE_IN_USE) {
      errCode = "DEVICE_IN_USE";
      errMsg = "该输出设备正被其他程序占用，无法启用独占模式";
      return false;
    }

    if (FAILED(hr)) {
      // Event-Driven 不被驱动接受时自动回退至定时独占模式
      eventDriven_ = false;
      client_.reset();
      hr = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client_.put());
      if (SUCCEEDED(hr) && client_) {
        REFERENCE_TIME timerBuf = std::max<REFERENCE_TIME>(defPeriod * 4, 400000LL);
        hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, 0, timerBuf, 0, wfxPtr, nullptr);
        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
          UINT32 frames = 0;
          if (SUCCEEDED(client_->GetBufferSize(&frames)) && frames > 0) {
            REFERENCE_TIME alignedHns = (REFERENCE_TIME)((10000000.0 * (double)frames / (double)hwFmt_.sampleRate) + 0.5);
            client_.reset();
            hr = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client_.put());
            if (SUCCEEDED(hr) && client_) {
              hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, 0, alignedHns, 0, wfxPtr, nullptr);
            }
          }
        }
      }
    }

    if (hr == AUDCLNT_E_DEVICE_IN_USE) {
      errCode = "DEVICE_IN_USE";
      errMsg = "该输出设备正被其他程序占用，无法启用独占模式";
      return false;
    }
    if (FAILED(hr)) {
      errCode = "EXCLUSIVE_INIT_FAILED";
      errMsg = "无法初始化 WASAPI 独占模式";
      return false;
    }

    if (FAILED(client_->GetBufferSize(&bufferFrames_)) || bufferFrames_ == 0) {
      errCode = "EXCLUSIVE_INIT_FAILED";
      errMsg = "获取独占缓冲区大小失败";
      return false;
    }

    if (eventDriven_) {
      eventHandle_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (!eventHandle_ || FAILED(client_->SetEventHandle(eventHandle_))) {
        errCode = "EXCLUSIVE_INIT_FAILED";
        errMsg = "独占事件句柄注册失败";
        return false;
      }
    }

    if (FAILED(client_->GetService(__uuidof(IAudioRenderClient), (void**)renderClient_.put())) || !renderClient_) {
      errCode = "EXCLUSIVE_INIT_FAILED";
      errMsg = "无法获取音频渲染服务";
      return false;
    }
    if (SUCCEEDED(client_->GetService(__uuidof(IAudioClock), (void**)clock_.put())) && clock_) {
      clock_->GetFrequency(&clockFreq_);
    }

    hwVolSupported_ = false;
    if (SUCCEEDED(device_->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, (void**)epVol_.put())) && epVol_) {
      DWORD mask = 0;
      if (SUCCEEDED(epVol_->QueryHardwareSupport(&mask)) && (mask & ENDPOINT_HARDWARE_SUPPORT_VOLUME)) {
        hwVolSupported_ = true;
      }
      // 绝不改写系统/DAC 主音量或静音状态，避免外接 USB DAC 音量被强制拉高或反复跳变
      epVol_.reset();
    }
    return true;
  }

  void writeRenderBuffer(uint32_t framesToWrite, bool& decEof, bool& streamErr, uint32_t& silentFramesAfterEof) {
    BYTE* dst = nullptr;
    HRESULT hr = renderClient_->GetBuffer(framesToWrite, &dst);
    if (FAILED(hr) || !dst) {
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED) deviceLostFlag_ = true;
      return;
    }
    const size_t frameBytes = hwFmt_.wfx.Format.nBlockAlign;
    if (decEof || streamErr) {
      std::memset(dst, 0, (size_t)framesToWrite * frameBytes);
      renderClient_->ReleaseBuffer(framesToWrite, AUDCLNT_BUFFERFLAGS_SILENT);
      silentFramesAfterEof += framesToWrite;
      return;
    }

    bool m = muted_.load();
    double v = volume_.load();
    double targetGain = m ? 0.0 : std::clamp(v, 0.0, 1.0);
    double rampStep = 1.0 / std::max(1.0, (double)hwFmt_.sampleRate * 0.015);

    uint32_t writtenTotal = 0;
    while (writtenTotal < framesToWrite) {
      std::vector<uint8_t> pcm;
      uint32_t gotFrames = 0;
      bool eof = false;
      if (!readCurrentFrames(framesToWrite - writtenTotal, pcm, gotFrames, eof)) {
        streamErr = true;
        break;
      }
      if (gotFrames > 0) {
        convertSamples(pcm.data(), decoder_->format(),
                       dst + (size_t)writtenTotal * frameBytes,
                       hwFmt_, gotFrames, curGain_, targetGain, rampStep);
        writtenTotal += gotFrames;
        decodedFramesWritten_.fetch_add(gotFrames, std::memory_order_relaxed);
      }
      if (eof) {
        // Phase 3 无缝播放（Gapless）：同采样率且同声道数的预载下一首在当前同一 DMA 缓冲内无缝拼接，零静音零切频
        std::unique_ptr<QueuedTrack> nxt;
        {
          std::lock_guard<std::mutex> nlk(nextMtx_);
          if (nextTrack_ && nextTrack_->decoder) {
            const auto& nf = nextTrack_->decoder->format();
            if (nf.sampleRate == hwFmt_.sampleRate && nf.channels == hwFmt_.channels) {
              nxt = std::move(nextTrack_);
            } else {
              nextTrack_.reset();
            }
          }
        }
        if (nxt) {
          decoder_ = std::move(nxt->decoder);
          curWarmPcm_ = std::move(nxt->warmPcm);
          curWarmFrames_ = nxt->warmFrames;
          curWarmPos_ = nxt->warmPos;
          curWarmEof_ = nxt->warmEof;
          const SourceFormat nsf = decoder_->format();
          {
            std::lock_guard<std::mutex> dlk(decInfoMtx_);
            curSrcFmt_ = nsf;
            hasCurSrcFmt_ = true;
          }
          posAnchorSec_ = 0.0;
          decodedFramesWritten_.store(0, std::memory_order_relaxed);
          bool bp = isBitPerfectFor(nsf);
          std::ostringstream oss;
          oss << "{\"ev\":\"gapless_advanced\","
              << "\"trackId\":\"" << jsonEscape(nxt->trackId) << "\","
              << "\"duration\":" << nsf.duration << ","
              << "\"pos\":0,"
              << "\"srcRate\":" << nsf.sampleRate << ","
              << "\"srcBits\":" << nsf.bitsPerSample << ","
              << "\"srcChannels\":" << nsf.channels << ","
              << "\"srcLossy\":" << (nsf.isLossy ? "true" : "false") << ","
              << "\"hwRate\":" << hwFmt_.sampleRate << ","
              << "\"hwBits\":" << hwFmt_.validBits << ","
              << "\"hwContainerBits\":" << hwFmt_.containerBits << ","
              << "\"hwChannels\":" << hwFmt_.channels << ","
              << "\"driverMode\":\"" << (eventDriven_ ? "event" : "timer") << "\","
              << "\"volumeMode\":\"" << currentVolumeMode() << "\","
              << "\"hwVolumeAvailable\":" << (hwVolSupported_ ? "true" : "false") << ","
              << "\"bitPerfect\":" << (bp ? "true" : "false") << ","
              << "\"deviceId\":\"" << jsonEscape(activeDeviceId_) << "\"}";
          emitLine(oss.str());
          continue;
        }
        decEof = true;
        break;
      }
      if (gotFrames == 0) break;
    }

    if (writtenTotal < framesToWrite) {
      std::memset(dst + (size_t)writtenTotal * frameBytes, 0, (size_t)(framesToWrite - writtenTotal) * frameBytes);
    }
    renderClient_->ReleaseBuffer(framesToWrite, (writtenTotal == 0 && streamErr) ? AUDCLNT_BUFFERFLAGS_SILENT : 0);
    if (writtenTotal > 0) {
      LARGE_INTEGER qpc{};
      QueryPerformanceCounter(&qpc);
      lastWriteQpc_.store(qpc.QuadPart, std::memory_order_relaxed);
    }
  }

  void renderLoop() {
    DWORD taskIndex = 0;
    HANDLE hTask = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    bool started = false;
    bool decEof = false;
    bool streamErr = false;
    uint32_t silentAfterEof = 0;
    ULONGLONG lastTickMs = 0;

    while (!stopThread_.load()) {
      if (deviceLostFlag_.load()) {
        emitLine("{\"ev\":\"device_lost\",\"code\":\"DEVICE_INVALIDATED\",\"message\":\"USB 音频设备已断开，已暂停播放\"}");
        playing_ = false;
        break;
      }

      if (!playing_.load()) {
        if (started && client_) {
          client_->Stop();
          started = false;
          streamStarted_ = false;
        }
        Sleep(20);
        continue;
      }

      if (!started) {
        if (!preRollDone_) {
          // 仅首次启动/跳转后写入 1 周期静音，避免 DAC 切换采样率吸合时吞字；普通暂停续播不叠加静音
          BYTE* sil = nullptr;
          UINT32 pad = 0;
          if (eventDriven_) {
            if (SUCCEEDED(renderClient_->GetBuffer(bufferFrames_, &sil)) && sil) {
              std::memset(sil, 0, (size_t)bufferFrames_ * hwFmt_.wfx.Format.nBlockAlign);
              renderClient_->ReleaseBuffer(bufferFrames_, AUDCLNT_BUFFERFLAGS_SILENT);
            }
          } else if (SUCCEEDED(client_->GetCurrentPadding(&pad))) {
            UINT32 avail = bufferFrames_ > pad ? bufferFrames_ - pad : 0;
            if (avail > 0 && SUCCEEDED(renderClient_->GetBuffer(avail, &sil)) && sil) {
              std::memset(sil, 0, (size_t)avail * hwFmt_.wfx.Format.nBlockAlign);
              renderClient_->ReleaseBuffer(avail, AUDCLNT_BUFFERFLAGS_SILENT);
            }
          }
          preRollDone_ = true;
        }
        HRESULT shr = client_->Start();
        if (shr == AUDCLNT_E_DEVICE_INVALIDATED) {
          deviceLostFlag_ = true;
          continue;
        }
        if (FAILED(shr)) {
          playing_ = false;
          emitLine("{\"ev\":\"error\",\"code\":\"START_FAILED\",\"message\":\"无法启动独占音频流\"}");
          continue;
        }
        started = true;
        streamStarted_ = true;
        LARGE_INTEGER startQpc{};
        QueryPerformanceCounter(&startQpc);
        lastWriteQpc_.store(startQpc.QuadPart, std::memory_order_relaxed);
        decEof = false;
        streamErr = false;
        silentAfterEof = 0;
        lastTickMs = 0;
      }

      if (eventDriven_) {
        DWORD w = WaitForSingleObject(eventHandle_, 300);
        if (stopThread_.load() || !playing_.load()) continue;
        if (w == WAIT_OBJECT_0) {
          writeRenderBuffer(bufferFrames_, decEof, streamErr, silentAfterEof);
        }
      } else {
        Sleep(10);
        if (stopThread_.load() || !playing_.load()) continue;
        UINT32 pad = 0;
        HRESULT phr = client_->GetCurrentPadding(&pad);
        if (phr == AUDCLNT_E_DEVICE_INVALIDATED) {
          deviceLostFlag_ = true;
          continue;
        }
        if (SUCCEEDED(phr) && bufferFrames_ > pad) {
          writeRenderBuffer(bufferFrames_ - pad, decEof, streamErr, silentAfterEof);
        }
      }

      if (deviceLostFlag_.load()) continue;

      if (streamErr) {
        double pos = currentPosLockedUnsafe();
        playing_ = false;
        if (client_) client_->Stop();
        started = false;
        streamStarted_ = false;
        char buf[256];
        std::snprintf(buf, sizeof(buf),
          "{\"ev\":\"error\",\"code\":\"STREAM_READ_FAILED\",\"pos\":%.4f,\"message\":\"音频流读取中断\"}", pos);
        emitLine(buf);
        continue;
      }

      if (decEof && silentAfterEof >= bufferFrames_) {
        double dur = currentDurationSafe();
        playing_ = false;
        endedState_ = true;
        if (client_) client_->Stop();
        started = false;
        streamStarted_ = false;
        char buf[192];
        std::snprintf(buf, sizeof(buf), "{\"ev\":\"ended\",\"pos\":%.4f,\"dur\":%.4f}", dur, dur);
        emitLine(buf);
        continue;
      }

      ULONGLONG now = GetTickCount64();
      if (now - lastTickMs >= 80) {
        lastTickMs = now;
        double pos = currentPosLockedUnsafe();
        double dur = currentDurationSafe();
        char buf[192];
        std::snprintf(buf, sizeof(buf), "{\"ev\":\"tick\",\"pos\":%.4f,\"dur\":%.4f}", pos, dur);
        emitLine(buf);
      }
    }

    streamStarted_ = false;
    if (started && client_) client_->Stop();
    if (hTask) AvRevertMmThreadCharacteristics(hTask);
  }

  double currentPosLockedUnsafe() const {
    double pos = posAnchorSec_;
    // 基于已写入的真实解码采样帧数减去硬件缓冲延迟，并叠加 QPC 亚周期插值：
    // 不依赖各厂商 UAC2 驱动（尤其 24-bit 紧致打包格式）下常漂移的 IAudioClock::GetPosition
    uint64_t written = decodedFramesWritten_.load(std::memory_order_relaxed);
    if (written > 0 && hwFmt_.sampleRate > 0) {
      uint64_t latency = 0;
      if (eventDriven_) {
        latency = bufferFrames_;
      } else if (client_) {
        UINT32 pad = 0;
        if (SUCCEEDED(client_->GetCurrentPadding(&pad))) latency = pad;
      }
      uint64_t played = (written > latency) ? (written - latency) : 0;
      double playedSec = (double)played / (double)hwFmt_.sampleRate;
      if (playing_.load() && streamStarted_.load(std::memory_order_relaxed) && !endedState_ && qpcFreq_ > 0) {
        LONGLONG lq = lastWriteQpc_.load(std::memory_order_relaxed);
        if (lq > 0) {
          LARGE_INTEGER nowQpc{};
          QueryPerformanceCounter(&nowQpc);
          double sub = (double)(nowQpc.QuadPart - lq) / (double)qpcFreq_;
          double maxSub = (double)bufferFrames_ / (double)hwFmt_.sampleRate;
          if (sub > 0.0) playedSec += std::min(sub, maxSub);
        }
      }
      pos += playedSec;
    }
    double dur = currentDurationSafe();
    if (dur > 0.0) {
      pos = std::min(pos, dur);
    }
    return std::max(0.0, pos);
  }

public:
  bool init() {
    LARGE_INTEGER fq{};
    QueryPerformanceFrequency(&fq);
    qpcFreq_ = fq.QuadPart;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)enumerator_.put());
    if (FAILED(hr) || !enumerator_) return false;
    notify_ = new NotificationClient();
    enumerator_->RegisterEndpointNotificationCallback(notify_);
    return true;
  }

  ~AudioEngine() {
    {
      std::lock_guard<std::mutex> lk(ctrlMtx_);
      releaseSessionLocked();
    }
    if (enumerator_ && notify_) {
      enumerator_->UnregisterEndpointNotificationCallback(notify_);
      notify_->Release();
      notify_ = nullptr;
    }
  }

  void onHotplugEvent(const std::string& id, bool removedOrInactive) {
    if (removedOrInactive && !id.empty() && id == activeDeviceId_) {
      deviceLostFlag_ = true;
      if (eventHandle_) SetEvent(eventHandle_);
    }
    emitLine("{\"ev\":\"devices_changed\"}");
  }

  std::string cmdDevices(int64_t id) {
    if (!enumerator_) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"NO_ENUM\",\"message\":\"音频枚举器未初始化\"}";
    }
    std::string defId;
    ComPtr<IMMDevice> defDev;
    if (SUCCEEDED(enumerator_->GetDefaultAudioEndpoint(eRender, eConsole, defDev.put())) && defDev) {
      LPWSTR w = nullptr;
      if (SUCCEEDED(defDev->GetId(&w)) && w) { defId = wideToUtf8(w); CoTaskMemFree(w); }
    }

    ComPtr<IMMDeviceCollection> col;
    if (FAILED(enumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, col.put())) || !col) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":true,\"devices\":[]}";
    }

    UINT count = 0;
    col->GetCount(&count);
    std::ostringstream oss;
    oss << "{\"id\":" << id << ",\"ok\":true,\"devices\":[";
    bool first = true;
    for (UINT i = 0; i < count; i++) {
      ComPtr<IMMDevice> dev;
      if (FAILED(col->Item(i, dev.put())) || !dev) continue;
      LPWSTR wid = nullptr;
      std::string devId;
      if (SUCCEEDED(dev->GetId(&wid)) && wid) { devId = wideToUtf8(wid); CoTaskMemFree(wid); }
      if (devId.empty()) continue;

      ComPtr<IPropertyStore> store;
      dev->OpenPropertyStore(STGM_READ, store.put());
      std::string name = propStr(store.p, PKEY_Device_FriendlyName);
      if (name.empty()) name = propStr(store.p, PKEY_Device_DeviceDesc);
      if (name.empty()) name = "音频输出设备";
      std::string enumeratorName = propStr(store.p, PKEY_Device_EnumeratorName);
      std::string ifaceName = propStr(store.p, PKEY_DeviceInterface_FriendlyName);

      bool isUsb = containsIgnoreCase(enumeratorName, "USB") ||
                   containsIgnoreCase(ifaceName, "USB") ||
                   containsIgnoreCase(name, "USB") ||
                   containsIgnoreCase(name, "DAC") ||
                   containsIgnoreCase(name, "UAC");

      if (!first) oss << ",";
      first = false;
      oss << "{\"id\":\"" << jsonEscape(devId) << "\","
          << "\"name\":\"" << jsonEscape(name) << "\","
          << "\"isDefault\":" << (devId == defId ? "true" : "false") << ","
          << "\"isUsb\":" << (isUsb ? "true" : "false") << "}";
    }
    oss << "]}";
    return oss.str();
  }

  std::string cmdLoad(int64_t id, const JVal& req) {
    std::lock_guard<std::mutex> lk(ctrlMtx_);
    releaseSessionLocked();

    std::string filePath = req.getStr("path");
    std::string devId = req.getStr("deviceId");
    volume_ = std::clamp(req.getNum("volume", 0.78), 0.0, 1.0);
    muted_ = req.getBool("muted", false);
    curGain_ = muted_.load() ? 0.0 : volume_.load();
    bool autoplay = req.getBool("autoplay", true);
    double seekTo = std::max(0.0, req.getNum("seekTo", 0.0));

    if (filePath.empty()) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"BAD_PATH\",\"message\":\"未提供音频文件路径\"}";
    }

    std::string decErr;
    if (!openDecoderForPath(filePath, decoder_, decErr)) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"E_UNSUPPORTED_FORMAT\",\"message\":\"" + jsonEscape(decErr) + "\"}";
    }

    const SourceFormat sf = decoder_->format();
    {
      std::lock_guard<std::mutex> dlk(decInfoMtx_);
      curSrcFmt_ = sf;
      hasCurSrcFmt_ = true;
    }
    std::string errCode, errMsg;
    if (!initWasapiSession(devId, sf, errCode, errMsg)) {
      releaseSessionLocked();
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"" + jsonEscape(errCode) +
             "\",\"message\":\"" + jsonEscape(errMsg) + "\"}";
    }

    decodedFramesWritten_ = 0;
    lastWriteQpc_ = 0;
    streamStarted_ = false;
    preRollDone_ = false;
    posAnchorSec_ = 0.0;
    if (seekTo > 0.0) {
      if (sf.duration > 0.0) seekTo = std::min(seekTo, std::max(0.0, sf.duration - 0.05));
      double actualSec = seekTo;
      decoder_->seek(seekTo, actualSec);
      posAnchorSec_ = actualSec;
    }

    stopThread_ = false;
    playing_ = autoplay;
    endedState_ = false;
    renderThread_ = std::thread(&AudioEngine::renderLoop, this);

    bool bp = isBitPerfectNow();
    std::ostringstream oss;
    oss << "{\"id\":" << id << ",\"ok\":true,"
        << "\"duration\":" << sf.duration << ","
        << "\"pos\":" << posAnchorSec_ << ","
        << "\"srcRate\":" << sf.sampleRate << ","
        << "\"srcBits\":" << sf.bitsPerSample << ","
        << "\"srcChannels\":" << sf.channels << ","
        << "\"srcLossy\":" << (sf.isLossy ? "true" : "false") << ","
        << "\"hwRate\":" << hwFmt_.sampleRate << ","
        << "\"hwBits\":" << hwFmt_.validBits << ","
        << "\"hwContainerBits\":" << hwFmt_.containerBits << ","
        << "\"hwChannels\":" << hwFmt_.channels << ","
        << "\"driverMode\":\"" << (eventDriven_ ? "event" : "timer") << "\","
        << "\"volumeMode\":\"" << currentVolumeMode() << "\","
        << "\"hwVolumeAvailable\":" << (hwVolSupported_ ? "true" : "false") << ","
        << "\"bitPerfect\":" << (bp ? "true" : "false") << ","
        << "\"deviceId\":\"" << jsonEscape(activeDeviceId_) << "\"}";
    return oss.str();
  }

  std::string cmdPlay(int64_t id) {
    std::lock_guard<std::mutex> lk(ctrlMtx_);
    if (!client_ || !decoder_) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"NOT_LOADED\",\"message\":\"未加载音频\"}";
    }
    if (endedState_) {
      // 播完后重播自动回到开头
      stopThread_ = true;
      if (eventHandle_) SetEvent(eventHandle_);
      if (renderThread_.joinable()) { ctrlMtx_.unlock(); renderThread_.join(); ctrlMtx_.lock(); }
      client_->Reset();
      curWarmPcm_.clear();
      curWarmFrames_ = 0;
      curWarmPos_ = 0;
      curWarmEof_ = false;
      double actualSec = 0.0;
      decoder_->seek(0.0, actualSec);
      posAnchorSec_ = actualSec;
      decodedFramesWritten_ = 0;
      lastWriteQpc_ = 0;
      streamStarted_ = false;
      preRollDone_ = false;
      endedState_ = false;
      stopThread_ = false;
      playing_ = true;
      renderThread_ = std::thread(&AudioEngine::renderLoop, this);
    } else {
      playing_ = true;
    }
    emitLine("{\"ev\":\"state\",\"playing\":true}");
    return "{\"id\":" + std::to_string(id) + ",\"ok\":true}";
  }

  std::string cmdPause(int64_t id) {
    std::lock_guard<std::mutex> lk(ctrlMtx_);
    if (!client_ || !decoder_) return "{\"id\":" + std::to_string(id) + ",\"ok\":true}";
    playing_ = false;
    double cur = currentPosLockedUnsafe();
    emitLine("{\"ev\":\"state\",\"playing\":false}");
    char buf[128];
    std::snprintf(buf, sizeof(buf), "{\"id\":%lld,\"ok\":true,\"pos\":%.4f}", (long long)id, cur);
    return buf;
  }

  std::string cmdStop(int64_t id) {
    std::lock_guard<std::mutex> lk(ctrlMtx_);
    releaseSessionLocked();
    return "{\"id\":" + std::to_string(id) + ",\"ok\":true}";
  }

  std::string cmdSeek(int64_t id, const JVal& req) {
    std::lock_guard<std::mutex> lk(ctrlMtx_);
    if (!client_ || !decoder_) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"NOT_LOADED\",\"message\":\"未加载音频\"}";
    }
    double target = std::max(0.0, req.getNum("time", 0.0));
    double dur = decoder_->format().duration;
    if (dur > 0.0) target = std::min(target, std::max(0.0, dur - 0.05));

    bool wasPlaying = playing_.load();
    stopThread_ = true;
    if (eventHandle_) SetEvent(eventHandle_);
    if (renderThread_.joinable()) {
      ctrlMtx_.unlock();
      renderThread_.join();
      ctrlMtx_.lock();
    }

    client_->Stop();
    client_->Reset();
    curWarmPcm_.clear();
    curWarmFrames_ = 0;
    curWarmPos_ = 0;
    curWarmEof_ = false;
    double actualSec = target;
    decoder_->seek(target, actualSec);
    posAnchorSec_ = actualSec;
    decodedFramesWritten_ = 0;
    lastWriteQpc_ = 0;
    streamStarted_ = false;
    preRollDone_ = false;
    endedState_ = false;
    stopThread_ = false;
    playing_ = wasPlaying;
    renderThread_ = std::thread(&AudioEngine::renderLoop, this);

    char buf[128];
    std::snprintf(buf, sizeof(buf), "{\"id\":%lld,\"ok\":true,\"pos\":%.4f}", (long long)id, actualSec);
    return buf;
  }

  std::string cmdVolume(int64_t id, const JVal& req) {
    std::lock_guard<std::mutex> lk(ctrlMtx_);
    volume_ = std::clamp(req.getNum("volume", volume_.load()), 0.0, 1.0);
    muted_ = req.getBool("muted", muted_.load());
    bool bp = isBitPerfectNow();
    std::ostringstream oss;
    oss << "{\"id\":" << id << ",\"ok\":true,"
        << "\"bitPerfect\":" << (bp ? "true" : "false") << ","
        << "\"volumeMode\":\"" << currentVolumeMode() << "\","
        << "\"hwVolumeAvailable\":" << (hwVolSupported_ ? "true" : "false") << "}";
    return oss.str();
  }

  std::string cmdQueueNext(int64_t id, const JVal& req) {
    std::string filePath = req.getStr("path");
    std::string trackId = req.getStr("trackId");
    if (filePath.empty()) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"BAD_PATH\",\"message\":\"未提供下一首音频路径\"}";
    }
    uint32_t curRate = 0;
    uint16_t curCh = 0;
    {
      std::lock_guard<std::mutex> lk(ctrlMtx_);
      if (!client_ || !decoder_) {
        return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"NOT_LOADED\",\"message\":\"当前无活动独占会话\"}";
      }
      curRate = hwFmt_.sampleRate;
      curCh = hwFmt_.channels;
    }

    // 在锁外完成下一首解码器打开与首段 PCM 预热（4096 帧），绝不阻塞实时音频渲染线程
    std::unique_ptr<AudioDecoder> nd;
    std::string decErr;
    if (!openDecoderForPath(filePath, nd, decErr) || !nd) {
      return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"E_UNSUPPORTED_FORMAT\",\"message\":\"" + jsonEscape(decErr) + "\"}";
    }
    const SourceFormat nsf = nd->format();
    if (nsf.sampleRate != curRate || nsf.channels != curCh) {
      {
        std::lock_guard<std::mutex> nlk(nextMtx_);
        nextTrack_.reset();
      }
      std::ostringstream oss;
      oss << "{\"id\":" << id << ",\"ok\":true,\"compatible\":false,\"reason\":\"FORMAT_CHANGE\","
          << "\"nextRate\":" << nsf.sampleRate << ",\"hwRate\":" << curRate << ","
          << "\"nextChannels\":" << nsf.channels << ",\"hwChannels\":" << curCh << "}";
      return oss.str();
    }

    auto qt = std::make_unique<QueuedTrack>();
    qt->trackId = trackId;
    uint32_t warmGot = 0;
    bool warmEof = false;
    if (nd->readFrames(4096, qt->warmPcm, warmGot, warmEof)) {
      qt->warmFrames = warmGot;
      qt->warmPos = 0;
      qt->warmEof = warmEof;
    }
    qt->decoder = std::move(nd);

    {
      std::lock_guard<std::mutex> nlk(nextMtx_);
      nextTrack_ = std::move(qt);
    }
    std::ostringstream oss;
    oss << "{\"id\":" << id << ",\"ok\":true,\"compatible\":true,"
        << "\"nextRate\":" << nsf.sampleRate << ",\"hwRate\":" << curRate << ","
        << "\"duration\":" << nsf.duration << "}";
    return oss.str();
  }

  std::string cmdClearNext(int64_t id) {
    std::lock_guard<std::mutex> nlk(nextMtx_);
    nextTrack_.reset();
    return "{\"id\":" + std::to_string(id) + ",\"ok\":true}";
  }
};

HRESULT STDMETHODCALLTYPE NotificationClient::OnDeviceStateChanged(LPCWSTR pwstrDeviceId, DWORD dwNewState) {
  if (g_engine && pwstrDeviceId) {
    g_engine->onHotplugEvent(wideToUtf8(pwstrDeviceId), dwNewState != DEVICE_STATE_ACTIVE);
  }
  return S_OK;
}
HRESULT STDMETHODCALLTYPE NotificationClient::OnDeviceAdded(LPCWSTR pwstrDeviceId) {
  if (g_engine) g_engine->onHotplugEvent(pwstrDeviceId ? wideToUtf8(pwstrDeviceId) : "", false);
  return S_OK;
}
HRESULT STDMETHODCALLTYPE NotificationClient::OnDeviceRemoved(LPCWSTR pwstrDeviceId) {
  if (g_engine && pwstrDeviceId) g_engine->onHotplugEvent(wideToUtf8(pwstrDeviceId), true);
  return S_OK;
}
HRESULT STDMETHODCALLTYPE NotificationClient::OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) {
  if (g_engine && flow == eRender && role == eConsole) g_engine->onHotplugEvent("", false);
  return S_OK;
}

int main() {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, nullptr, _IONBF, 0);

  HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  MFStartup(MF_VERSION);

  {
    AudioEngine engine;
    g_engine = &engine;
    if (!engine.init()) {
      emitLine("{\"ev\":\"error\",\"code\":\"INIT_FAILED\",\"message\":\"初始化音频接口失败\"}");
    }
    emitLine("{\"ev\":\"ready\"}");

    std::string line;
    char buf[4096];
    auto processLine = [&](const std::string& raw) {
      if (raw.empty()) return true;
      JParser parser(raw);
      JVal req;
      if (!parser.parseValue(req) || req.type != JVal::Obj) return true;
      int64_t id = req.getInt("id", 0);
      std::string cmd = req.getStr("cmd");
      if (cmd == "ping") {
        emitLine("{\"id\":" + std::to_string(id) + ",\"ok\":true,\"version\":\"1.3.0\"}");
      } else if (cmd == "devices") {
        emitLine(engine.cmdDevices(id));
      } else if (cmd == "load") {
        emitLine(engine.cmdLoad(id, req));
      } else if (cmd == "play") {
        emitLine(engine.cmdPlay(id));
      } else if (cmd == "pause") {
        emitLine(engine.cmdPause(id));
      } else if (cmd == "stop") {
        emitLine(engine.cmdStop(id));
      } else if (cmd == "seek") {
        emitLine(engine.cmdSeek(id, req));
      } else if (cmd == "volume") {
        emitLine(engine.cmdVolume(id, req));
      } else if (cmd == "queue_next") {
        emitLine(engine.cmdQueueNext(id, req));
      } else if (cmd == "clear_next") {
        emitLine(engine.cmdClearNext(id));
      } else if (cmd == "quit") {
        emitLine("{\"id\":" + std::to_string(id) + ",\"ok\":true}");
        return false;
      } else {
        emitLine("{\"id\":" + std::to_string(id) + ",\"ok\":false,\"code\":\"BAD_CMD\",\"message\":\"未知指令\"}");
      }
      return true;
    };

    const int stdinFd = _fileno(stdin);
    while (true) {
      int nr = _read(stdinFd, buf, sizeof(buf));
      if (nr <= 0) break;
      size_t n = (size_t)nr;
      for (size_t i = 0; i < n; i++) {
        if (buf[i] == '\n') {
          if (!line.empty() && line.back() == '\r') line.pop_back();
          bool keep = processLine(line);
          line.clear();
          if (!keep) goto loop_done;
        } else {
          line.push_back(buf[i]);
        }
      }
    }
    if (!line.empty()) {
      if (line.back() == '\r') line.pop_back();
      processLine(line);
    }

  loop_done:
    g_engine = nullptr;
  }

  MFShutdown();
  if (SUCCEEDED(comHr)) CoUninitialize();
  return 0;
}

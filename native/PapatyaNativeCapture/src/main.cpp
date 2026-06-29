#include <windows.h>
#include <avrt.h>
#include <audioclient.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "Logger.h"
#include "NvEncoder/NvEncoderD3D11.h"

using Microsoft::WRL::ComPtr;

simplelogger::Logger* logger = nullptr;

namespace {

struct EncodedFrame {
  std::vector<uint8_t> bytes;
  int64_t timestampMs = 0;
  uint64_t index = 0;
  bool keyFrame = false;
};

struct CaptureSettings {
  int fps = 30;
  int clipSeconds = 30;
  int bitrateKbps = 6000;
  bool includeSystemAudio = true;
  bool includeMic = false;
  std::string outputDir;
  std::string tempDir;
};

struct SaveResult {
  std::string videoPath;
  std::string systemAudioPath;
  std::string micAudioPath;
  int64_t startedAt = 0;
  int64_t endedAt = 0;
  int64_t systemAudioStartedAt = 0;
  int64_t micAudioStartedAt = 0;
  double duration = 0.0;
  int fps = 30;
  uint32_t width = 0;
  uint32_t height = 0;
};

struct AudioBlock {
  std::vector<uint8_t> bytes;
  int64_t startedAt = 0;
  int64_t endedAt = 0;
};

std::mutex g_outMutex;
std::unique_ptr<class NativeCaptureEngine> g_engine;

int64_t unixNowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (size <= 0) return {};
  std::wstring wide(static_cast<size_t>(size - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), size);
  return wide;
}

std::string narrow(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, out.data(), size, nullptr, nullptr);
  return out;
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          out << "\\u";
          out.width(4);
          out.fill('0');
          out << std::hex << static_cast<int>(ch) << std::dec;
        } else {
          out << ch;
        }
        break;
    }
  }
  return out.str();
}

void emitRaw(const std::string& payload) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  std::cout << payload << std::endl;
}

void emitReady() {
  emitRaw("{\"type\":\"ready\",\"engine\":\"native-nvenc\",\"protocol\":3}");
}

void emitError(const std::string& id, const std::string& code, const std::string& message) {
  std::ostringstream out;
  out << "{\"type\":\"error\"";
  if (!id.empty()) out << ",\"id\":\"" << jsonEscape(id) << "\"";
  out << ",\"code\":\"" << jsonEscape(code) << "\""
      << ",\"message\":\"" << jsonEscape(message) << "\"}";
  emitRaw(out.str());
}

void emitStopped(const std::string& id) {
  std::ostringstream out;
  out << "{\"type\":\"stopped\"";
  if (!id.empty()) out << ",\"id\":\"" << jsonEscape(id) << "\"";
  out << "}";
  emitRaw(out.str());
}

std::string extractString(const std::string& line, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const auto keyPos = line.find(needle);
  if (keyPos == std::string::npos) return {};
  const auto colonPos = line.find(':', keyPos + needle.size());
  if (colonPos == std::string::npos) return {};
  const auto quotePos = line.find('"', colonPos + 1);
  if (quotePos == std::string::npos) return {};
  std::string value;
  bool escape = false;
  for (auto i = quotePos + 1; i < line.size(); ++i) {
    const char ch = line[i];
    if (escape) {
      switch (ch) {
        case 'n': value.push_back('\n'); break;
        case 'r': value.push_back('\r'); break;
        case 't': value.push_back('\t'); break;
        default: value.push_back(ch); break;
      }
      escape = false;
      continue;
    }
    if (ch == '\\') {
      escape = true;
      continue;
    }
    if (ch == '"') break;
    value.push_back(ch);
  }
  return value;
}

int extractInt(const std::string& line, const std::string& key, int fallback) {
  const std::string needle = "\"" + key + "\"";
  const auto keyPos = line.find(needle);
  if (keyPos == std::string::npos) return fallback;
  const auto colonPos = line.find(':', keyPos + needle.size());
  if (colonPos == std::string::npos) return fallback;
  const auto start = line.find_first_of("-0123456789", colonPos + 1);
  if (start == std::string::npos) return fallback;
  const auto end = line.find_first_not_of("0123456789-", start);
  try {
    return std::stoi(line.substr(start, end == std::string::npos ? std::string::npos : end - start));
  } catch (...) {
    return fallback;
  }
}

bool extractBool(const std::string& line, const std::string& key, bool fallback) {
  const std::string needle = "\"" + key + "\"";
  const auto keyPos = line.find(needle);
  if (keyPos == std::string::npos) return fallback;
  const auto colonPos = line.find(':', keyPos + needle.size());
  if (colonPos == std::string::npos) return fallback;
  const auto valuePos = line.find_first_not_of(" \t\r\n", colonPos + 1);
  if (valuePos == std::string::npos) return fallback;
  if (line.compare(valuePos, 4, "true") == 0) return true;
  if (line.compare(valuePos, 5, "false") == 0) return false;
  return fallback;
}

int64_t extractInt64(const std::string& line, const std::string& key, int64_t fallback) {
  const std::string needle = "\"" + key + "\"";
  const auto keyPos = line.find(needle);
  if (keyPos == std::string::npos) return fallback;
  const auto colonPos = line.find(':', keyPos + needle.size());
  if (colonPos == std::string::npos) return fallback;
  const auto start = line.find_first_of("-0123456789", colonPos + 1);
  if (start == std::string::npos) return fallback;
  const auto end = line.find_first_not_of("0123456789-", start);
  try {
    return std::stoll(line.substr(start, end == std::string::npos ? std::string::npos : end - start));
  } catch (...) {
    return fallback;
  }
}

std::string sanitizeFilePart(std::string value) {
  if (value.empty()) value = "Papatya";
  for (char& ch : value) {
    if (ch == '<' || ch == '>' || ch == ':' || ch == '"' || ch == '/' ||
        ch == '\\' || ch == '|' || ch == '?' || ch == '*') {
      ch = '-';
    }
  }
  while (!value.empty() && (value.back() == '.' || value.back() == ' ')) value.pop_back();
  if (value.empty()) value = "Papatya";
  return value;
}

bool nvencRuntimeAvailable() {
  HMODULE module = LoadLibraryW(L"nvEncodeAPI64.dll");
  if (!module) return false;
  const auto proc = GetProcAddress(module, "NvEncodeAPICreateInstance");
  FreeLibrary(module);
  return proc != nullptr;
}

void throwIfFailed(HRESULT hr, const char* message) {
  if (FAILED(hr)) {
    std::ostringstream out;
    out << message << " (0x" << std::hex << static_cast<unsigned long>(hr) << ")";
    throw std::runtime_error(out.str());
  }
}

void writeU16(std::ofstream& out, uint16_t value) {
  out.put(static_cast<char>(value & 0xff));
  out.put(static_cast<char>((value >> 8) & 0xff));
}

void writeU32(std::ofstream& out, uint32_t value) {
  out.put(static_cast<char>(value & 0xff));
  out.put(static_cast<char>((value >> 8) & 0xff));
  out.put(static_cast<char>((value >> 16) & 0xff));
  out.put(static_cast<char>((value >> 24) & 0xff));
}

void writeWaveFile(const std::filesystem::path& path, const std::vector<uint8_t>& formatBytes, const std::vector<AudioBlock>& blocks) {
  if (formatBytes.size() < sizeof(WAVEFORMATEX)) {
    throw std::runtime_error("Native audio format is invalid");
  }

  uint64_t dataSize64 = 0;
  for (const auto& block : blocks) dataSize64 += block.bytes.size();
  if (dataSize64 == 0) throw std::runtime_error("Native audio buffer is empty");
  if (dataSize64 > 0x7fffffffULL) throw std::runtime_error("Native audio clip is too large");

  std::filesystem::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("Native audio wav could not be opened");

  const uint32_t fmtSize = static_cast<uint32_t>(formatBytes.size());
  const uint32_t dataSize = static_cast<uint32_t>(dataSize64);
  const uint32_t riffSize = 4 + 8 + fmtSize + 8 + dataSize;
  out.write("RIFF", 4);
  writeU32(out, riffSize);
  out.write("WAVE", 4);
  out.write("fmt ", 4);
  writeU32(out, fmtSize);
  out.write(reinterpret_cast<const char*>(formatBytes.data()), fmtSize);
  out.write("data", 4);
  writeU32(out, dataSize);
  for (const auto& block : blocks) {
    out.write(reinterpret_cast<const char*>(block.bytes.data()), static_cast<std::streamsize>(block.bytes.size()));
  }
}

class WasapiRingCapture {
public:
  WasapiRingCapture(bool loopback, std::string label)
    : loopback_(loopback), label_(std::move(label)) {}

  ~WasapiRingCapture() {
    stop();
  }

  void start(int clipSeconds) {
    stop();
    keepSeconds_ = std::clamp(clipSeconds + 10, 10, 360);
    running_.store(true);
    thread_ = std::thread([this] { captureLoop(); });
  }

  void stop() {
    running_.store(false);
    if (thread_.joinable()) thread_.join();
  }

  bool hasFormat() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return !formatBytes_.empty();
  }

  bool save(const std::filesystem::path& path, int64_t startMs, int64_t endMs, int64_t& actualStartMs) {
    std::vector<AudioBlock> selected;
    std::vector<uint8_t> formatBytes;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      formatBytes = formatBytes_;
      for (const auto& block : blocks_) {
        if (block.endedAt >= startMs && block.startedAt <= endMs) selected.push_back(block);
      }
    }

    if (selected.empty() || formatBytes.empty()) return false;
    actualStartMs = selected.front().startedAt;
    writeWaveFile(path, formatBytes, selected);
    return true;
  }

private:
  void captureLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
    if (mmcss) AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_NORMAL);

    try {
      ComPtr<IMMDeviceEnumerator> enumerator;
      throwIfFailed(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)),
                    "WASAPI device enumerator olusturulamadi");

      ComPtr<IMMDevice> device;
      throwIfFailed(enumerator->GetDefaultAudioEndpoint(loopback_ ? eRender : eCapture, eConsole, device.GetAddressOf()),
                    loopback_ ? "Varsayilan sistem sesi cihazi yok" : "Varsayilan mikrofon cihazi yok");

      ComPtr<IAudioClient> audioClient;
      throwIfFailed(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(audioClient.GetAddressOf())),
                    "WASAPI audio client acilamadi");

      WAVEFORMATEX* mixFormat = nullptr;
      throwIfFailed(audioClient->GetMixFormat(&mixFormat), "WASAPI mix format alinamadi");
      const auto formatGuard = std::unique_ptr<WAVEFORMATEX, decltype(&CoTaskMemFree)>(mixFormat, CoTaskMemFree);
      if (!mixFormat || mixFormat->nBlockAlign == 0 || mixFormat->nSamplesPerSec == 0) {
        throw std::runtime_error("WASAPI mix format gecersiz");
      }

      {
        std::lock_guard<std::mutex> lock(mutex_);
        const size_t formatSize = sizeof(WAVEFORMATEX) + mixFormat->cbSize;
        formatBytes_.assign(reinterpret_cast<uint8_t*>(mixFormat), reinterpret_cast<uint8_t*>(mixFormat) + formatSize);
        sampleRate_ = mixFormat->nSamplesPerSec;
        blockAlign_ = mixFormat->nBlockAlign;
      }

      const REFERENCE_TIME bufferDuration = 10000000;
      const DWORD streamFlags = loopback_ ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
      throwIfFailed(audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, bufferDuration, 0, mixFormat, nullptr),
                    loopback_ ? "Sistem sesi WASAPI baslatilamadi" : "Mikrofon WASAPI baslatilamadi");

      ComPtr<IAudioCaptureClient> captureClient;
      throwIfFailed(audioClient->GetService(IID_PPV_ARGS(&captureClient)), "WASAPI capture client alinamadi");
      throwIfFailed(audioClient->Start(), "WASAPI audio baslatilamadi");

      while (running_.load()) {
        UINT32 packetFrames = 0;
        HRESULT hr = captureClient->GetNextPacketSize(&packetFrames);
        if (FAILED(hr)) break;
        while (packetFrames > 0) {
          BYTE* data = nullptr;
          UINT32 frames = 0;
          DWORD flags = 0;
          UINT64 devicePosition = 0;
          UINT64 qpcPosition = 0;
          hr = captureClient->GetBuffer(&data, &frames, &flags, &devicePosition, &qpcPosition);
          if (FAILED(hr)) break;
          pushPacket(data, frames, flags);
          captureClient->ReleaseBuffer(frames);
          hr = captureClient->GetNextPacketSize(&packetFrames);
          if (FAILED(hr)) break;
        }
        Sleep(5);
      }

      audioClient->Stop();
    } catch (...) {
      running_.store(false);
    }

    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    CoUninitialize();
  }

  void pushPacket(const BYTE* data, UINT32 frames, DWORD flags) {
    if (frames == 0 || blockAlign_ == 0 || sampleRate_ == 0) return;
    const size_t byteCount = static_cast<size_t>(frames) * static_cast<size_t>(blockAlign_);
    AudioBlock block;
    block.bytes.resize(byteCount);
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
      std::fill(block.bytes.begin(), block.bytes.end(), uint8_t{0});
    } else {
      std::memcpy(block.bytes.data(), data, byteCount);
    }

    const int64_t durationMs = std::max<int64_t>(1, static_cast<int64_t>((static_cast<double>(frames) * 1000.0) / sampleRate_));
    block.endedAt = unixNowMs();
    block.startedAt = block.endedAt - durationMs;

    std::lock_guard<std::mutex> lock(mutex_);
    blocks_.push_back(std::move(block));
    const int64_t cutoff = unixNowMs() - static_cast<int64_t>(keepSeconds_) * 1000;
    while (!blocks_.empty() && blocks_.front().endedAt < cutoff) {
      blocks_.pop_front();
    }
  }

  bool loopback_ = false;
  std::string label_;
  std::atomic<bool> running_{false};
  std::thread thread_;
  mutable std::mutex mutex_;
  std::deque<AudioBlock> blocks_;
  std::vector<uint8_t> formatBytes_;
  int keepSeconds_ = 40;
  int sampleRate_ = 0;
  int blockAlign_ = 0;
};

class NativeCaptureEngine {
public:
  ~NativeCaptureEngine() {
    stop();
  }

  void start(const CaptureSettings& settings) {
    stop();
    settings_ = settings;
    settings_.fps = std::clamp(settings_.fps, 15, 120);
    settings_.clipSeconds = std::clamp(settings_.clipSeconds, 3, 300);
    settings_.bitrateKbps = std::clamp(settings_.bitrateKbps, 1000, 50000);
    maxBufferedFrames_ = static_cast<size_t>((settings_.clipSeconds + 8) * settings_.fps);

    initializeD3D();
    initializeEncoder();
    initializeAudio();

    running_.store(true);
    captureThread_ = std::thread([this] { captureLoop(); });
  }

  void stop() {
    running_.store(false);
    if (captureThread_.joinable()) captureThread_.join();
    if (systemAudio_) systemAudio_->stop();
    if (micAudio_) micAudio_->stop();
    systemAudio_.reset();
    micAudio_.reset();
    {
      std::lock_guard<std::mutex> lock(ringMutex_);
      ring_.clear();
    }
    if (encoder_) {
      try {
        encoder_->DestroyEncoder();
      } catch (...) {
      }
      encoder_.reset();
    }
    duplication_.Reset();
    lastFrame_.Reset();
    context_.Reset();
    device_.Reset();
    width_ = 0;
    height_ = 0;
    frameIndex_ = 0;
    droppedFrames_ = 0;
  }

  SaveResult save(const std::string& title, int64_t requestedAt) {
    std::vector<EncodedFrame> frames;
    int64_t clipStart = requestedAt - static_cast<int64_t>(settings_.clipSeconds) * 1000;
    {
      std::lock_guard<std::mutex> lock(ringMutex_);
      for (const auto& frame : ring_) {
        if (frame.timestampMs <= requestedAt && frame.timestampMs >= clipStart - 2500) {
          frames.push_back(frame);
        }
      }
    }

    if (frames.empty()) {
      throw std::runtime_error("Native video buffer is empty");
    }

    std::sort(frames.begin(), frames.end(), [](const EncodedFrame& a, const EncodedFrame& b) {
      return a.index < b.index;
    });

    size_t startIndex = 0;
    for (size_t i = 0; i < frames.size(); ++i) {
      if (frames[i].timestampMs <= clipStart && frames[i].keyFrame) {
        startIndex = i;
      }
    }
    if (!frames[startIndex].keyFrame) {
      for (size_t i = 0; i < frames.size(); ++i) {
        if (frames[i].keyFrame) {
          startIndex = i;
          break;
        }
      }
    }

    std::vector<EncodedFrame> selected(frames.begin() + static_cast<std::ptrdiff_t>(startIndex), frames.end());
    if (selected.empty()) {
      throw std::runtime_error("Native video buffer has no decodable frame");
    }

    const std::filesystem::path dir = !settings_.tempDir.empty()
      ? std::filesystem::path(widen(settings_.tempDir))
      : std::filesystem::path(widen(settings_.outputDir));
    std::filesystem::create_directories(dir);
    const auto fileName = sanitizeFilePart(title) + "-native-" + std::to_string(unixNowMs()) + ".h264";
    const std::filesystem::path videoPath = dir / widen(fileName);

    std::ofstream out(videoPath, std::ios::binary);
    if (!out) {
      throw std::runtime_error("Native temp video file could not be opened");
    }
    for (const auto& frame : selected) {
      out.write(reinterpret_cast<const char*>(frame.bytes.data()), static_cast<std::streamsize>(frame.bytes.size()));
    }
    out.close();

    SaveResult result;
    result.videoPath = narrow(videoPath.wstring());
    result.startedAt = selected.front().timestampMs;
    result.endedAt = selected.back().timestampMs;
    result.duration = std::max(0.1, (result.endedAt - result.startedAt) / 1000.0);
    result.fps = settings_.fps;
    result.width = width_;
    result.height = height_;

    if (systemAudio_) {
      const std::filesystem::path systemPath = dir / widen(sanitizeFilePart(title) + "-native-system-" + std::to_string(unixNowMs()) + ".wav");
      int64_t audioStart = 0;
      if (systemAudio_->save(systemPath, result.startedAt, result.endedAt, audioStart)) {
        result.systemAudioPath = narrow(systemPath.wstring());
        result.systemAudioStartedAt = audioStart;
      }
    }

    if (micAudio_) {
      const std::filesystem::path micPath = dir / widen(sanitizeFilePart(title) + "-native-mic-" + std::to_string(unixNowMs()) + ".wav");
      int64_t audioStart = 0;
      if (micAudio_->save(micPath, result.startedAt, result.endedAt, audioStart)) {
        result.micAudioPath = narrow(micPath.wstring());
        result.micAudioStartedAt = audioStart;
      }
    }

    return result;
  }

  bool isRunning() const {
    return running_.load();
  }

private:
  void initializeD3D() {
    ComPtr<IDXGIFactory1> factory;
    throwIfFailed(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.GetAddressOf())),
                  "DXGI factory olusturulamadi");

    ComPtr<IDXGIAdapter1> selectedAdapter;
    ComPtr<IDXGIOutput> selectedOutput;

    for (UINT adapterIndex = 0; ; ++adapterIndex) {
      ComPtr<IDXGIAdapter1> adapter;
      if (factory->EnumAdapters1(adapterIndex, adapter.GetAddressOf()) == DXGI_ERROR_NOT_FOUND) break;

      DXGI_ADAPTER_DESC1 adapterDesc{};
      adapter->GetDesc1(&adapterDesc);
      if (adapterDesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;

      ComPtr<IDXGIOutput> output;
      if (FAILED(adapter->EnumOutputs(0, output.GetAddressOf()))) continue;

      ComPtr<ID3D11Device> testDevice;
      ComPtr<ID3D11DeviceContext> testContext;
      D3D_FEATURE_LEVEL featureLevel{};
      const D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0
      };
      const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
      if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
                                   levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                                   testDevice.GetAddressOf(), &featureLevel, testContext.GetAddressOf()))) {
        continue;
      }

      selectedAdapter = adapter;
      selectedOutput = output;
      device_ = testDevice;
      context_ = testContext;
      break;
    }

    if (!device_ || !selectedOutput) {
      throw std::runtime_error("D3D11 desktop adapter bulunamadi");
    }

    DXGI_OUTPUT_DESC outputDesc{};
    throwIfFailed(selectedOutput->GetDesc(&outputDesc), "Monitor bilgisi alinamadi");
    width_ = static_cast<uint32_t>(outputDesc.DesktopCoordinates.right - outputDesc.DesktopCoordinates.left);
    height_ = static_cast<uint32_t>(outputDesc.DesktopCoordinates.bottom - outputDesc.DesktopCoordinates.top);
    if (width_ == 0 || height_ == 0) {
      throw std::runtime_error("Monitor cozunurlugu gecersiz");
    }

    ComPtr<IDXGIOutput1> output1;
    throwIfFailed(selectedOutput.As(&output1), "DXGI Output1 alinamadi");
    throwIfFailed(output1->DuplicateOutput(device_.Get(), duplication_.GetAddressOf()),
                  "Desktop Duplication baslatilamadi");

    D3D11_TEXTURE2D_DESC lastDesc{};
    lastDesc.Width = width_;
    lastDesc.Height = height_;
    lastDesc.MipLevels = 1;
    lastDesc.ArraySize = 1;
    lastDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    lastDesc.SampleDesc.Count = 1;
    lastDesc.Usage = D3D11_USAGE_DEFAULT;
    lastDesc.BindFlags = 0;
    lastDesc.CPUAccessFlags = 0;
    throwIfFailed(device_->CreateTexture2D(&lastDesc, nullptr, lastFrame_.GetAddressOf()),
                  "Son frame texture olusturulamadi");
  }

  void initializeEncoder() {
    encoder_ = std::make_unique<NvEncoderD3D11>(
      device_.Get(),
      width_,
      height_,
      NV_ENC_BUFFER_FORMAT_ARGB,
      0,
      false,
      false
    );

    NV_ENC_INITIALIZE_PARAMS initializeParams = { NV_ENC_INITIALIZE_PARAMS_VER };
    NV_ENC_CONFIG encodeConfig = { NV_ENC_CONFIG_VER };
    initializeParams.encodeConfig = &encodeConfig;

    encoder_->CreateDefaultEncoderParams(
      &initializeParams,
      NV_ENC_CODEC_H264_GUID,
      NV_ENC_PRESET_P1_GUID,
      NV_ENC_TUNING_INFO_LOW_LATENCY
    );

    const uint32_t bitrate = static_cast<uint32_t>(settings_.bitrateKbps) * 1000U;
    initializeParams.encodeWidth = width_;
    initializeParams.encodeHeight = height_;
    initializeParams.darWidth = width_;
    initializeParams.darHeight = height_;
    initializeParams.frameRateNum = static_cast<uint32_t>(settings_.fps);
    initializeParams.frameRateDen = 1;
    initializeParams.enablePTD = 1;
    initializeParams.enableEncodeAsync = 0;

    encodeConfig.gopLength = static_cast<uint32_t>(settings_.fps);
    encodeConfig.frameIntervalP = 1;
    encodeConfig.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    encodeConfig.rcParams.averageBitRate = bitrate;
    encodeConfig.rcParams.maxBitRate = bitrate;
    encodeConfig.rcParams.vbvBufferSize = bitrate;
    encodeConfig.rcParams.vbvInitialDelay = bitrate;
    encodeConfig.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
    encodeConfig.encodeCodecConfig.h264Config.idrPeriod = static_cast<uint32_t>(settings_.fps);

    encoder_->CreateEncoder(&initializeParams);
  }

  void initializeAudio() {
    if (settings_.includeSystemAudio) {
      try {
        systemAudio_ = std::make_unique<WasapiRingCapture>(true, "system");
        systemAudio_->start(settings_.clipSeconds);
      } catch (...) {
        systemAudio_.reset();
      }
    }

    if (settings_.includeMic) {
      try {
        micAudio_ = std::make_unique<WasapiRingCapture>(false, "mic");
        micAudio_->start(settings_.clipSeconds);
      } catch (...) {
        micAudio_.reset();
      }
    }
  }

  bool acquireFrame() {
    DXGI_OUTDUPL_FRAME_INFO frameInfo{};
    ComPtr<IDXGIResource> desktopResource;
    const HRESULT hr = duplication_->AcquireNextFrame(5, &frameInfo, desktopResource.GetAddressOf());
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      return true;
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
      throw std::runtime_error("Desktop Duplication access lost");
    }
    throwIfFailed(hr, "Desktop frame alinamadi");

    ComPtr<ID3D11Texture2D> frameTexture;
    const HRESULT queryHr = desktopResource.As(&frameTexture);
    if (SUCCEEDED(queryHr)) {
      context_->CopyResource(lastFrame_.Get(), frameTexture.Get());
    }
    duplication_->ReleaseFrame();
    throwIfFailed(queryHr, "Desktop frame texture alinamadi");
    return true;
  }

  void encodeLastFrame() {
    const NvEncInputFrame* inputFrame = encoder_->GetNextInputFrame();
    auto* encoderTexture = reinterpret_cast<ID3D11Texture2D*>(inputFrame->inputPtr);
    context_->CopyResource(encoderTexture, lastFrame_.Get());

    NV_ENC_PIC_PARAMS picParams = {};
    picParams.inputTimeStamp = frameIndex_;
    picParams.inputDuration = 1;
    if (frameIndex_ == 0 || frameIndex_ % static_cast<uint64_t>(settings_.fps) == 0) {
      picParams.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }

    std::vector<NvEncOutputFrame> packets;
    encoder_->EncodeFrame(packets, &picParams);
    const int64_t ts = unixNowMs();
    for (const auto& packet : packets) {
      if (packet.frame.empty()) continue;
      EncodedFrame frame;
      frame.bytes = packet.frame;
      frame.timestampMs = ts;
      frame.index = packet.timeStamp;
      frame.keyFrame = packet.pictureType == NV_ENC_PIC_TYPE_IDR || packet.pictureType == NV_ENC_PIC_TYPE_I;
      pushFrame(std::move(frame));
    }
    frameIndex_ += 1;
  }

  void pushFrame(EncodedFrame frame) {
    std::lock_guard<std::mutex> lock(ringMutex_);
    ring_.push_back(std::move(frame));
    while (ring_.size() > maxBufferedFrames_) {
      ring_.pop_front();
    }
  }

  void captureLoop() {
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Capture", &taskIndex);
    if (mmcss) AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_NORMAL);

    int framesThisSecond = 0;
    int64_t lastStatusAt = unixNowMs();
    auto nextFrame = std::chrono::steady_clock::now();
    const auto frameInterval = std::chrono::microseconds(1000000 / std::max(1, settings_.fps));

    try {
      while (running_.load()) {
        nextFrame += frameInterval;
        acquireFrame();
        encodeLastFrame();
        framesThisSecond += 1;

        const int64_t now = unixNowMs();
        if (now - lastStatusAt >= 1000) {
          size_t buffered = 0;
          {
            std::lock_guard<std::mutex> lock(ringMutex_);
            buffered = ring_.size();
          }
          std::ostringstream event;
          event << "{\"type\":\"recording\",\"bufferedSeconds\":"
                << std::min(settings_.clipSeconds, static_cast<int>(buffered / std::max(1, settings_.fps)))
                << ",\"fps\":" << framesThisSecond
                << ",\"droppedFrames\":" << droppedFrames_.load()
                << "}";
          emitRaw(event.str());
          framesThisSecond = 0;
          lastStatusAt = now;
        }

        const auto beforeSleep = std::chrono::steady_clock::now();
        if (nextFrame > beforeSleep) {
          std::this_thread::sleep_until(nextFrame);
        } else {
          droppedFrames_.fetch_add(1);
          nextFrame = beforeSleep;
        }
      }
    } catch (const std::exception& error) {
      running_.store(false);
      emitError("", "CAPTURE_FAILED", error.what());
    }

    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  }

  CaptureSettings settings_;
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> droppedFrames_{0};
  std::thread captureThread_;
  std::mutex ringMutex_;
  std::deque<EncodedFrame> ring_;
  size_t maxBufferedFrames_ = 0;
  uint64_t frameIndex_ = 0;
  uint32_t width_ = 0;
  uint32_t height_ = 0;

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<ID3D11Texture2D> lastFrame_;
  std::unique_ptr<NvEncoderD3D11> encoder_;
  std::unique_ptr<WasapiRingCapture> systemAudio_;
  std::unique_ptr<WasapiRingCapture> micAudio_;
};

CaptureSettings parseStartSettings(const std::string& line) {
  CaptureSettings settings;
  settings.fps = extractInt(line, "fps", 30);
  settings.clipSeconds = extractInt(line, "clipSeconds", 30);
  settings.bitrateKbps = extractInt(line, "bitrateKbps", 6000);
  settings.includeSystemAudio = extractBool(line, "includeSystemAudio", true);
  settings.includeMic = extractBool(line, "includeMic", false);
  settings.outputDir = extractString(line, "outputDir");
  settings.tempDir = extractString(line, "tempDir");
  if (settings.outputDir.empty() && settings.tempDir.empty()) {
    throw std::runtime_error("Native outputDir/tempDir bos");
  }
  return settings;
}

void handleStart(const std::string& line) {
  const std::string id = extractString(line, "id");
  if (!nvencRuntimeAvailable()) {
    emitError(id, "NO_NVENC", "NVIDIA NVENC runtime bulunamadi. Ekran karti surucusunu guncelle.");
    return;
  }

  try {
    auto engine = std::make_unique<NativeCaptureEngine>();
    engine->start(parseStartSettings(line));
    g_engine = std::move(engine);

    std::ostringstream out;
    out << "{\"type\":\"started\",\"id\":\"" << jsonEscape(id)
        << "\",\"engine\":\"native-nvenc\"}";
    emitRaw(out.str());
  } catch (const NVENCException& error) {
    emitError(id, "NVENC_FAILED", error.getErrorString());
  } catch (const std::exception& error) {
    emitError(id, "CAPTURE_FAILED", error.what());
  }
}

void handleSave(const std::string& line) {
  const std::string id = extractString(line, "id");
  if (!g_engine || !g_engine->isRunning()) {
    emitError(id, "NOT_RECORDING", "Native capture aktif degil.");
    return;
  }

  try {
    const std::string title = extractString(line, "title");
    const int64_t requestedAt = extractInt64(line, "requestedAt", unixNowMs());
    const auto result = g_engine->save(title, requestedAt);

    std::ostringstream out;
    out << "{\"type\":\"saved\",\"id\":\"" << jsonEscape(id) << "\""
        << ",\"videoPath\":\"" << jsonEscape(result.videoPath) << "\""
        << ",\"systemAudioPath\":\"" << jsonEscape(result.systemAudioPath) << "\""
        << ",\"micAudioPath\":\"" << jsonEscape(result.micAudioPath) << "\""
        << ",\"startedAt\":" << result.startedAt
        << ",\"endedAt\":" << result.endedAt
        << ",\"systemAudioStartedAt\":" << result.systemAudioStartedAt
        << ",\"micAudioStartedAt\":" << result.micAudioStartedAt
        << ",\"duration\":" << result.duration
        << ",\"fps\":" << result.fps
        << ",\"width\":" << result.width
        << ",\"height\":" << result.height
        << ",\"audio\":\"native\"}";
    emitRaw(out.str());
  } catch (const std::exception& error) {
    emitError(id, "SAVE_FAILED", error.what());
  }
}

void handleStop(const std::string& line) {
  const std::string id = extractString(line, "id");
  if (g_engine) {
    g_engine->stop();
    g_engine.reset();
  }
  emitStopped(id);
}

void handleStatus(const std::string& line) {
  const std::string id = extractString(line, "id");
  std::ostringstream out;
  out << "{\"type\":\"metrics\"";
  if (!id.empty()) out << ",\"id\":\"" << jsonEscape(id) << "\"";
  out << ",\"cpu\":0,\"gpuEncode\":0,\"memoryMb\":0}";
  emitRaw(out.str());
}

}  // namespace

int main() {
  SetConsoleOutputCP(CP_UTF8);
  emitReady();

  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string type = extractString(line, "type");
    if (type == "start") {
      handleStart(line);
    } else if (type == "save") {
      handleSave(line);
    } else if (type == "stop") {
      handleStop(line);
    } else if (type == "status") {
      handleStatus(line);
    } else if (type == "shutdown") {
      handleStop(line);
      break;
    } else {
      emitError(extractString(line, "id"), "BAD_COMMAND", "Bilinmeyen native capture komutu.");
    }
  }

  if (g_engine) {
    g_engine->stop();
    g_engine.reset();
  }
  return 0;
}

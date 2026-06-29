# PapatyaNativeCapture

This helper is the stdio JSON-lines bridge for the native replay engine.

The current build captures the primary desktop output with D3D11 Desktop Duplication,
encodes frames with NVIDIA NVENC into an in-memory H.264 replay buffer, captures
system loopback and microphone audio with WASAPI ring buffers, and returns temporary
`.h264`/`.wav` slices on `save`. Electron muxes those native slices into the final
`.mp4`.

Runtime requirement for users: NVIDIA driver with `nvEncodeAPI64.dll`.
Build requirement for developers: NVIDIA Video Codec SDK 13.x under
`Video_Codec_SDK_13.1.15` or pass `PAPATYA_NV_CODEC_SDK` to CMake.

Build:

```powershell
cmake -S native\PapatyaNativeCapture -B native\PapatyaNativeCapture\build -G "Visual Studio 18 2026" -A x64
cmake --build native\PapatyaNativeCapture\build --config Release
```

The packaged executable is copied to `assets/native-capture/PapatyaNativeCapture.exe`.

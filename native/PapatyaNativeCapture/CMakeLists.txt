cmake_minimum_required(VERSION 3.24)

project(PapatyaNativeCapture LANGUAGES CXX)

set(PAPATYA_NV_CODEC_SDK "" CACHE PATH "Path to NVIDIA Video Codec SDK")
if (NOT PAPATYA_NV_CODEC_SDK)
  set(PAPATYA_NV_CODEC_SDK "${CMAKE_CURRENT_SOURCE_DIR}/../../Video_Codec_SDK_13.1.15")
endif()
get_filename_component(PAPATYA_NV_CODEC_SDK "${PAPATYA_NV_CODEC_SDK}" ABSOLUTE)

if (NOT EXISTS "${PAPATYA_NV_CODEC_SDK}/Interface/nvEncodeAPI.h")
  message(FATAL_ERROR "NVIDIA Video Codec SDK bulunamadi. PAPATYA_NV_CODEC_SDK yolunu ayarla.")
endif()

add_executable(PapatyaNativeCapture
  src/main.cpp
  "${PAPATYA_NV_CODEC_SDK}/Samples/NvCodec/NvEncoder/NvEncoder.cpp"
  "${PAPATYA_NV_CODEC_SDK}/Samples/NvCodec/NvEncoder/NvEncoderD3D11.cpp"
)

target_compile_features(PapatyaNativeCapture PRIVATE cxx_std_20)
target_include_directories(PapatyaNativeCapture PRIVATE
  "${PAPATYA_NV_CODEC_SDK}/Interface"
  "${PAPATYA_NV_CODEC_SDK}/Samples"
  "${PAPATYA_NV_CODEC_SDK}/Samples/NvCodec"
  "${PAPATYA_NV_CODEC_SDK}/Samples/Utils"
)
target_compile_definitions(PapatyaNativeCapture PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
)

target_link_libraries(PapatyaNativeCapture PRIVATE
  d3d11
  dxgi
  mf
  mfplat
  mfuuid
  wmcodecdspuuid
  avrt
  ole32
  uuid
  "${PAPATYA_NV_CODEC_SDK}/Lib/win/x64/nvencodeapi.lib"
)

if (MSVC)
  target_compile_options(PapatyaNativeCapture PRIVATE /W4 /permissive-)
  target_compile_definitions(PapatyaNativeCapture PRIVATE _CRT_SECURE_NO_WARNINGS)
  set_property(TARGET PapatyaNativeCapture PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
endif()

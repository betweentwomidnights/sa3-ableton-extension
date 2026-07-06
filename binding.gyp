{
  "variables": {
    "sa3_cpp_dir%": "<!(node -p \"process.env.SA3_CPP_DIR || require('path').resolve(process.cwd(), '..', 'sa3.cpp')\")"
  },
  "targets": [
    {
      "target_name": "sa3_embedded",
      "sources": [
        "native/sa3_embedded_bridge.cpp"
      ],
      "include_dirs": [
        "<(sa3_cpp_dir)/src"
      ],
      "defines": [
        "NAPI_VERSION=10",
        "WIN32_LEAN_AND_MEAN"
      ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/std:c++17"
              ]
            }
          }
        }]
      ]
    }
  ]
}

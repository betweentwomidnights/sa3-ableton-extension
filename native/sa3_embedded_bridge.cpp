#include <node_api.h>

#include "libsa3.h"
#include "wav.h"

#ifdef _WIN32
#  include <windows.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct LoraOption {
  std::string name;
  float strength = 1.0f;
};

struct GenerateOptions {
  std::string models_dir;
  std::string adapters_dir;
  std::string variant = "medium";
  std::string encoding = "f16";
  std::string device;  // "" / "auto" -> libsa3 default (GPU then CPU); "cpu" -> force CPU
  int cpu_threads = 0;

  std::string prompt;
  std::string negative_prompt;
  double duration = 30.0;
  int target_samples = 0;
  int steps = 8;
  int64_t seed = -1;
  float cfg_scale = 1.0f;
  float duration_padding_sec = 6.0f;
  bool keep_models = false;
  std::string dist_shift = "LogSNR";

  std::string init_path;
  float init_noise_level = 0.85f;
  float inpaint_start = -1.0f;
  float inpaint_end = -1.0f;
  int encode_chunk_size = 128;
  int encode_overlap = 32;
  int decode_chunk_size = 128;
  int decode_overlap = 32;

  std::vector<LoraOption> loras;
};

struct GenerateWork {
  napi_env env = nullptr;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  napi_threadsafe_function tsfn = nullptr;  // optional progress callback bridge
  GenerateOptions options;
  std::string error;
  std::string wav_bytes;
  uint64_t seed = 0;
  int sample_rate = 0;
  int channels = 0;
  int samples = 0;
};

// One libsa3 progress tick, marshalled from the worker thread to the JS thread.
struct ProgressMsg {
  std::string stage;
  int step = 0;
  int total = 0;
  double fraction = 0.0;
};

struct ConvertLoraOptions {
  std::string safetensors_path;
  std::string json_path;
  std::string output_path;
};

struct ConvertLoraWork {
  napi_env env = nullptr;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  ConvertLoraOptions options;
  std::string error;
};

using Sa3InitExFn = sa3_context* (*)(const sa3_config_ex*, char*, int);
using Sa3GenerateExFn = int (*)(sa3_context*, const sa3_request_ex*, sa3_audio*, char*, int);
using Sa3ConvertLoraFn = int (*)(const char*, const char*, const char*, char*, int);
using Sa3FreeAudioFn = void (*)(sa3_audio*);
using Sa3UnloadFn = void (*)(sa3_context*);
using Sa3FreeFn = void (*)(sa3_context*);
using Sa3VersionFn = const char* (*)();

struct Sa3Api {
#ifdef _WIN32
  HMODULE module = nullptr;
#else
  void* module = nullptr;
#endif
  Sa3InitExFn init_ex = nullptr;
  Sa3GenerateExFn generate_ex = nullptr;
  Sa3ConvertLoraFn convert_lora = nullptr;
  Sa3FreeAudioFn free_audio = nullptr;
  Sa3UnloadFn unload = nullptr;
  Sa3FreeFn free = nullptr;
  Sa3VersionFn version = nullptr;
  std::string native_dir;
};

std::mutex g_api_mutex;
Sa3Api g_api;

std::mutex g_context_mutex;
sa3_context* g_context = nullptr;
std::string g_context_key;

void check(napi_status status, const char* message) {
  if (status != napi_ok) {
    throw std::runtime_error(message);
  }
}

std::string utf8_from_value(napi_env env, napi_value value) {
  size_t length = 0;
  check(napi_get_value_string_utf8(env, value, nullptr, 0, &length), "failed to read string length");
  std::string result(length, '\0');
  size_t copied = 0;
  check(napi_get_value_string_utf8(env, value, result.data(), result.size() + 1, &copied), "failed to read string");
  result.resize(copied);
  return result;
}

bool get_property(napi_env env, napi_value object, const char* key, napi_value* out) {
  bool has_property = false;
  check(napi_has_named_property(env, object, key, &has_property), "failed to inspect property");
  if (!has_property) return false;
  check(napi_get_named_property(env, object, key, out), "failed to get property");
  return true;
}

std::string get_string(napi_env env, napi_value object, const char* key, const std::string& fallback = "") {
  napi_value value;
  if (!get_property(env, object, key, &value)) return fallback;
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect value");
  if (type == napi_null || type == napi_undefined) return fallback;
  if (type != napi_string) return fallback;
  return utf8_from_value(env, value);
}

double get_double(napi_env env, napi_value object, const char* key, double fallback) {
  napi_value value;
  if (!get_property(env, object, key, &value)) return fallback;
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect value");
  if (type != napi_number) return fallback;
  double result = fallback;
  check(napi_get_value_double(env, value, &result), "failed to read number");
  return result;
}

int get_int(napi_env env, napi_value object, const char* key, int fallback) {
  napi_value value;
  if (!get_property(env, object, key, &value)) return fallback;
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect value");
  if (type != napi_number) return fallback;
  int32_t result = fallback;
  check(napi_get_value_int32(env, value, &result), "failed to read int");
  return (int)result;
}

int64_t get_int64(napi_env env, napi_value object, const char* key, int64_t fallback) {
  napi_value value;
  if (!get_property(env, object, key, &value)) return fallback;
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect value");
  if (type != napi_number) return fallback;
  int64_t result = fallback;
  check(napi_get_value_int64(env, value, &result), "failed to read int64");
  return result;
}

bool get_bool(napi_env env, napi_value object, const char* key, bool fallback) {
  napi_value value;
  if (!get_property(env, object, key, &value)) return fallback;
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect value");
  if (type != napi_boolean) return fallback;
  bool result = fallback;
  check(napi_get_value_bool(env, value, &result), "failed to read bool");
  return result;
}

std::vector<LoraOption> get_loras(napi_env env, napi_value object) {
  std::vector<LoraOption> result;
  napi_value value;
  if (!get_property(env, object, "loras", &value)) return result;
  bool is_array = false;
  check(napi_is_array(env, value, &is_array), "failed to inspect loras");
  if (!is_array) return result;

  uint32_t length = 0;
  check(napi_get_array_length(env, value, &length), "failed to read lora length");
  for (uint32_t i = 0; i < length; ++i) {
    napi_value item;
    check(napi_get_element(env, value, i, &item), "failed to read lora");
    napi_valuetype type;
    check(napi_typeof(env, item, &type), "failed to inspect lora");
    if (type != napi_object) continue;
    LoraOption lora;
    lora.name = get_string(env, item, "name", "");
    lora.strength = (float)get_double(env, item, "strength", 1.0);
    if (!lora.name.empty() && lora.strength > 0.0f) {
      result.push_back(std::move(lora));
    }
  }
  return result;
}

GenerateOptions parse_generate_options(napi_env env, napi_value value) {
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect options");
  if (type != napi_object) {
    throw std::runtime_error("generate options must be an object");
  }

  GenerateOptions options;
  options.models_dir = get_string(env, value, "modelsDir", "");
  options.adapters_dir = get_string(env, value, "adaptersDir", "");
  options.variant = get_string(env, value, "variant", options.variant);
  options.encoding = get_string(env, value, "encoding", options.encoding);
  options.device = get_string(env, value, "device", options.device);
  options.cpu_threads = get_int(env, value, "cpuThreads", options.cpu_threads);
  options.prompt = get_string(env, value, "prompt", "");
  options.negative_prompt = get_string(env, value, "negativePrompt", "");
  options.duration = get_double(env, value, "duration", options.duration);
  options.target_samples = get_int(env, value, "targetSamples", options.target_samples);
  options.steps = get_int(env, value, "steps", options.steps);
  options.seed = get_int64(env, value, "seed", options.seed);
  options.cfg_scale = (float)get_double(env, value, "cfgScale", options.cfg_scale);
  options.duration_padding_sec = (float)get_double(env, value, "durationPaddingSec", options.duration_padding_sec);
  options.keep_models = get_bool(env, value, "keepModels", options.keep_models);
  options.dist_shift = get_string(env, value, "distShift", options.dist_shift);
  options.init_path = get_string(env, value, "initPath", "");
  options.init_noise_level = (float)get_double(env, value, "initNoiseLevel", options.init_noise_level);
  options.inpaint_start = (float)get_double(env, value, "inpaintStart", options.inpaint_start);
  options.inpaint_end = (float)get_double(env, value, "inpaintEnd", options.inpaint_end);
  options.encode_chunk_size = get_int(env, value, "encodeChunkSize", options.encode_chunk_size);
  options.encode_overlap = get_int(env, value, "encodeOverlap", options.encode_overlap);
  options.decode_chunk_size = get_int(env, value, "decodeChunkSize", options.decode_chunk_size);
  options.decode_overlap = get_int(env, value, "decodeOverlap", options.decode_overlap);
  options.loras = get_loras(env, value);

  if (!std::isfinite(options.duration) || options.duration <= 0.0) {
    throw std::runtime_error("duration must be positive");
  }
  if (options.cpu_threads < 0) {
    throw std::runtime_error("cpuThreads must be >= 0");
  }
  return options;
}

ConvertLoraOptions parse_convert_lora_options(napi_env env, napi_value value) {
  napi_valuetype type;
  check(napi_typeof(env, value, &type), "failed to inspect options");
  if (type != napi_object) {
    throw std::runtime_error("convertLora options must be an object");
  }

  ConvertLoraOptions options;
  options.safetensors_path = get_string(env, value, "safetensorsPath", "");
  options.json_path = get_string(env, value, "jsonPath", "");
  options.output_path = get_string(env, value, "outputPath", "");
  if (options.safetensors_path.empty()) {
    throw std::runtime_error("safetensorsPath is required");
  }
  if (options.json_path.empty()) {
    throw std::runtime_error("jsonPath is required");
  }
  if (options.output_path.empty()) {
    throw std::runtime_error("outputPath is required");
  }
  return options;
}

#ifdef _WIN32
std::string utf8_from_wide(const std::wstring& value) {
  if (value.empty()) return "";
  int bytes = WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0, nullptr, nullptr);
  std::string result(bytes, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), result.data(), bytes, nullptr, nullptr);
  return result;
}

std::wstring module_directory_wide() {
  HMODULE self = nullptr;
  if (!GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&module_directory_wide),
        &self)) {
    throw std::runtime_error("GetModuleHandleExW failed");
  }

  std::wstring path(32768, L'\0');
  DWORD length = GetModuleFileNameW(self, path.data(), (DWORD)path.size());
  if (length == 0 || length >= path.size()) {
    throw std::runtime_error("GetModuleFileNameW failed");
  }
  path.resize(length);
  size_t slash = path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) {
    throw std::runtime_error("native module path has no directory");
  }
  return path.substr(0, slash);
}

std::string last_windows_error(const std::wstring& path) {
  DWORD code = GetLastError();
  LPWSTR message = nullptr;
  FormatMessageW(
    FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    nullptr,
    code,
    MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
    reinterpret_cast<LPWSTR>(&message),
    0,
    nullptr);

  std::ostringstream out;
  out << "failed to load " << utf8_from_wide(path) << " (Win32 " << code << ")";
  if (message) {
    out << ": " << utf8_from_wide(message);
    LocalFree(message);
  }
  return out.str();
}
#endif

void* get_symbol(Sa3Api& api, const char* name) {
#ifdef _WIN32
  void* symbol = reinterpret_cast<void*>(GetProcAddress(api.module, name));
#else
  void* symbol = nullptr;
#endif
  if (!symbol) {
    throw std::runtime_error(std::string("sa3.dll is missing symbol ") + name);
  }
  return symbol;
}

bool load_sa3_api(std::string& error) {
  std::lock_guard<std::mutex> lock(g_api_mutex);
  if (g_api.module) return true;

  try {
#ifdef _WIN32
    std::wstring dir = module_directory_wide();
    std::wstring dll_path = dir + L"\\sa3.dll";
    HMODULE module = LoadLibraryExW(
      dll_path.c_str(),
      nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!module) {
      error = last_windows_error(dll_path);
      return false;
    }
    g_api.module = module;
    g_api.native_dir = utf8_from_wide(dir);
#else
    error = "embedded SA3 is only wired for Windows in this prototype";
    return false;
#endif

    g_api.init_ex = reinterpret_cast<Sa3InitExFn>(get_symbol(g_api, "sa3_init_ex"));
    g_api.generate_ex = reinterpret_cast<Sa3GenerateExFn>(get_symbol(g_api, "sa3_generate_ex"));
    g_api.convert_lora = reinterpret_cast<Sa3ConvertLoraFn>(get_symbol(g_api, "sa3_convert_lora"));
    g_api.free_audio = reinterpret_cast<Sa3FreeAudioFn>(get_symbol(g_api, "sa3_free_audio"));
    g_api.unload = reinterpret_cast<Sa3UnloadFn>(get_symbol(g_api, "sa3_unload"));
    g_api.free = reinterpret_cast<Sa3FreeFn>(get_symbol(g_api, "sa3_free"));
    g_api.version = reinterpret_cast<Sa3VersionFn>(get_symbol(g_api, "sa3_version"));
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
}

// "cpu" forces the CPU backend via sa3_config_ex.device; anything else lets
// libsa3 pick a GPU (then fall back to CPU).
std::string normalized_device(const std::string& device) {
  return device == "cpu" ? "cpu" : "auto";
}

std::string context_key(const GenerateOptions& options) {
  std::ostringstream out;
  out << options.models_dir << '\n'
      << options.adapters_dir << '\n'
      << options.variant << '\n'
      << options.encoding << '\n'
      << normalized_device(options.device) << '\n'
      << options.cpu_threads;
  return out.str();
}

sa3_context* ensure_context(const GenerateOptions& options, Sa3Api& api, char* err, int err_len) {
  const std::string key = context_key(options);
  if (g_context && key == g_context_key) {
    return g_context;
  }

  if (g_context) {
    api.free(g_context);
    g_context = nullptr;
    g_context_key.clear();
  }

  sa3_config_ex config = {};
  config.config.models_dir = options.models_dir.empty() ? nullptr : options.models_dir.c_str();
  config.config.adapters_dir = options.adapters_dir.empty() ? nullptr : options.adapters_dir.c_str();
  config.config.variant = options.variant.empty() ? nullptr : options.variant.c_str();
  config.config.encoding = options.encoding.empty() ? nullptr : options.encoding.c_str();
  config.cpu_threads = options.cpu_threads;
  const std::string device = normalized_device(options.device);
  config.device = device == "cpu" ? "cpu" : nullptr;

  g_context = api.init_ex(&config, err, err_len);
  if (!g_context) {
    return nullptr;
  }
  g_context_key = key;
  return g_context;
}

// Runs on the JS thread: hand one progress tick to the JS callback.
void progress_call_js(napi_env env, napi_value js_cb, void* /*context*/, void* data) {
  auto* msg = static_cast<ProgressMsg*>(data);
  if (env != nullptr && js_cb != nullptr) {
    napi_value undefined, stage, step, total, fraction;
    napi_get_undefined(env, &undefined);
    napi_create_string_utf8(env, msg->stage.c_str(), NAPI_AUTO_LENGTH, &stage);
    napi_create_int32(env, msg->step, &step);
    napi_create_int32(env, msg->total, &total);
    napi_create_double(env, msg->fraction, &fraction);
    napi_value argv[4] = {stage, step, total, fraction};
    napi_call_function(env, undefined, js_cb, 4, argv, nullptr);
  }
  delete msg;
}

// Runs on the libsa3 worker thread: queue the tick for the JS thread.
void progress_trampoline(void* user, const char* stage, int step, int total, float fraction) {
  auto tsfn = static_cast<napi_threadsafe_function>(user);
  if (!tsfn) return;
  auto* msg = new ProgressMsg{stage ? stage : "", step, total, (double)fraction};
  if (napi_call_threadsafe_function(tsfn, msg, napi_tsfn_nonblocking) != napi_ok) {
    delete msg;
  }
}

void execute_generate(napi_env, void* data) {
  auto* work = static_cast<GenerateWork*>(data);
  std::string load_error;
  if (!load_sa3_api(load_error)) {
    work->error = load_error;
    return;
  }

  try {
    Sa3Api api;
    {
      std::lock_guard<std::mutex> lock(g_api_mutex);
      api = g_api;
    }

    std::vector<float> init_audio;
    int init_samples = 0;
    int init_channels = 0;
    int init_sample_rate = 0;
    if (!work->options.init_path.empty()) {
      init_audio = sa3::read_wav_planar(work->options.init_path, init_samples, init_channels, init_sample_rate);
    }

    std::vector<const char*> lora_names;
    std::vector<float> lora_strengths;
    lora_names.reserve(work->options.loras.size());
    lora_strengths.reserve(work->options.loras.size());
    for (const auto& lora : work->options.loras) {
      lora_names.push_back(lora.name.c_str());
      lora_strengths.push_back(lora.strength);
    }

    sa3_request_ex request = {};
    request.request.prompt = work->options.prompt.c_str();
    request.request.negative_prompt = work->options.negative_prompt.empty()
      ? nullptr
      : work->options.negative_prompt.c_str();
    request.request.frames = std::max(1, (int)(work->options.duration * 44100.0 / 4096.0 + 0.5));
    if (work->options.variant.rfind("small", 0) == 0 && (request.request.frames & 1)) {
      request.request.frames++;
    }
    request.request.steps = work->options.steps > 0 ? work->options.steps : 8;
    request.request.seed = work->options.seed;
    request.request.cfg_scale = work->options.cfg_scale;
    request.request.duration_padding_sec = work->options.duration_padding_sec;
    request.request.keep_models = work->options.keep_models ? 1 : 0;
    request.request.n_loras = (int)lora_names.size();
    request.request.lora_names = lora_names.empty() ? nullptr : lora_names.data();
    request.request.lora_strengths = lora_strengths.empty() ? nullptr : lora_strengths.data();
    request.request.dist_shift = work->options.dist_shift.empty() ? nullptr : work->options.dist_shift.c_str();
    request.encode_chunk_size = work->options.encode_chunk_size;
    request.encode_overlap = work->options.encode_overlap;
    request.decode_chunk_size = work->options.decode_chunk_size;
    request.decode_overlap = work->options.decode_overlap;

    if (work->tsfn) {
      request.request.on_progress = progress_trampoline;
      request.request.user = work->tsfn;
    }

    if (!init_audio.empty()) {
      request.init_audio.mode = (work->options.inpaint_start >= 0.0f || work->options.inpaint_end >= 0.0f)
        ? SA3_INIT_AUDIO_INPAINT
        : SA3_INIT_AUDIO_A2A;
      request.init_audio.samples = init_audio.data();
      request.init_audio.n_samp = init_samples;
      request.init_audio.n_ch = init_channels;
      request.init_audio.sample_rate = init_sample_rate;
      request.init_audio.init_noise_level = work->options.init_noise_level;
      request.init_audio.inpaint_start = work->options.inpaint_start;
      request.init_audio.inpaint_end = work->options.inpaint_end;
    }

    char err[4096] = {};
    sa3_audio audio = {};
    {
      std::lock_guard<std::mutex> lock(g_context_mutex);
      sa3_context* context = ensure_context(work->options, api, err, (int)sizeof(err));
      if (!context) {
        work->error = err[0] ? err : "sa3_init_ex failed";
        return;
      }

      int rc = api.generate_ex(context, &request, &audio, err, (int)sizeof(err));
      if (rc != 0) {
        work->error = err[0] ? err : "sa3_generate_ex failed";
        return;
      }
    }

    int output_samples = audio.n_samp;
    if (work->options.target_samples > 0) {
      output_samples = std::min(output_samples, work->options.target_samples);
    }

    if (output_samples < audio.n_samp && audio.n_ch > 1) {
      // wav_planar_bytes uses its length argument as the per-channel stride, so
      // passing a trimmed length against the full-length planar buffer would read
      // channels > 0 from the wrong offset (right channel shifted by the trimmed
      // tail). Compact each channel to the trimmed stride first.
      std::vector<float> compacted((size_t)output_samples * audio.n_ch);
      for (int c = 0; c < audio.n_ch; c++) {
        const float* src = audio.samples + (size_t)c * audio.n_samp;
        std::copy(src, src + output_samples, compacted.begin() + (size_t)c * output_samples);
      }
      work->wav_bytes = sa3::wav_planar_bytes(compacted.data(), output_samples, audio.n_ch, audio.sample_rate);
    } else {
      work->wav_bytes = sa3::wav_planar_bytes(audio.samples, output_samples, audio.n_ch, audio.sample_rate);
    }
    work->seed = audio.seed;
    work->sample_rate = audio.sample_rate;
    work->channels = audio.n_ch;
    work->samples = output_samples;
    api.free_audio(&audio);
  } catch (const std::exception& e) {
    work->error = e.what();
  } catch (...) {
    work->error = "unknown embedded SA3 error";
  }
}

void complete_generate(napi_env env, napi_status, void* data) {
  auto* work = static_cast<GenerateWork*>(data);

  if (!work->error.empty()) {
    napi_value message;
    napi_value error;
    napi_create_string_utf8(env, work->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value result;
    napi_create_object(env, &result);

    napi_value wav;
    napi_create_buffer_copy(env, work->wav_bytes.size(), work->wav_bytes.data(), nullptr, &wav);
    napi_set_named_property(env, result, "wav", wav);

    napi_value seed;
    std::string seed_text = std::to_string(work->seed);
    napi_create_string_utf8(env, seed_text.c_str(), NAPI_AUTO_LENGTH, &seed);
    napi_set_named_property(env, result, "seed", seed);

    napi_value sample_rate;
    napi_create_int32(env, work->sample_rate, &sample_rate);
    napi_set_named_property(env, result, "sampleRate", sample_rate);

    napi_value channels;
    napi_create_int32(env, work->channels, &channels);
    napi_set_named_property(env, result, "channels", channels);

    napi_value samples;
    napi_create_int32(env, work->samples, &samples);
    napi_set_named_property(env, result, "samples", samples);

    napi_resolve_deferred(env, work->deferred, result);
  }

  if (work->tsfn) {
    // Drops our thread-count ref; queued progress ticks still flush first.
    napi_release_threadsafe_function(work->tsfn, napi_tsfn_release);
  }
  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value generate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "failed to read generate args");
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "generate(options) requires an options object");
    return nullptr;
  }

  auto* work = new GenerateWork();
  work->env = env;
  try {
    work->options = parse_generate_options(env, argv[0]);
  } catch (const std::exception& e) {
    delete work;
    napi_throw_type_error(env, nullptr, e.what());
    return nullptr;
  }

  // Optional second arg: a progress callback (stage, step, total, fraction).
  if (argc >= 2) {
    napi_valuetype cb_type = napi_undefined;
    napi_typeof(env, argv[1], &cb_type);
    if (cb_type == napi_function) {
      napi_value progress_name;
      napi_create_string_utf8(env, "embedded-sa3-progress", NAPI_AUTO_LENGTH, &progress_name);
      napi_create_threadsafe_function(env, argv[1], nullptr, progress_name, 0, 1,
                                      nullptr, nullptr, nullptr, progress_call_js, &work->tsfn);
    }
  }

  napi_value promise;
  napi_create_promise(env, &work->deferred, &promise);
  napi_value resource_name;
  napi_create_string_utf8(env, "embedded-sa3-generate", NAPI_AUTO_LENGTH, &resource_name);
  napi_create_async_work(env, nullptr, resource_name, execute_generate, complete_generate, work, &work->work);
  napi_queue_async_work(env, work->work);
  return promise;
}

void execute_convert_lora(napi_env, void* data) {
  auto* work = static_cast<ConvertLoraWork*>(data);
  std::string load_error;
  if (!load_sa3_api(load_error)) {
    work->error = load_error;
    return;
  }

  try {
    Sa3Api api;
    {
      std::lock_guard<std::mutex> lock(g_api_mutex);
      api = g_api;
    }

    char err[4096] = {};
    int rc = api.convert_lora(
      work->options.safetensors_path.c_str(),
      work->options.json_path.c_str(),
      work->options.output_path.c_str(),
      err,
      (int)sizeof(err));
    if (rc != 0) {
      work->error = err[0] ? err : "sa3_convert_lora failed";
    }
  } catch (const std::exception& e) {
    work->error = e.what();
  } catch (...) {
    work->error = "unknown embedded SA3 LoRA conversion error";
  }
}

void complete_convert_lora(napi_env env, napi_status, void* data) {
  auto* work = static_cast<ConvertLoraWork*>(data);

  if (!work->error.empty()) {
    napi_value message;
    napi_value error;
    napi_create_string_utf8(env, work->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value result;
    napi_create_object(env, &result);

    napi_value output_path;
    napi_create_string_utf8(env, work->options.output_path.c_str(), NAPI_AUTO_LENGTH, &output_path);
    napi_set_named_property(env, result, "outputPath", output_path);

    napi_resolve_deferred(env, work->deferred, result);
  }

  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value convert_lora(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "failed to read convertLora args");
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "convertLora(options) requires an options object");
    return nullptr;
  }

  auto* work = new ConvertLoraWork();
  work->env = env;
  try {
    work->options = parse_convert_lora_options(env, argv[0]);
  } catch (const std::exception& e) {
    delete work;
    napi_throw_type_error(env, nullptr, e.what());
    return nullptr;
  }

  napi_value promise;
  napi_create_promise(env, &work->deferred, &promise);
  napi_value resource_name;
  napi_create_string_utf8(env, "embedded-sa3-convert-lora", NAPI_AUTO_LENGTH, &resource_name);
  napi_create_async_work(env, nullptr, resource_name, execute_convert_lora, complete_convert_lora, work, &work->work);
  napi_queue_async_work(env, work->work);
  return promise;
}

napi_value diagnostics(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);

  std::string error;
  bool ok = load_sa3_api(error);

  napi_value available;
  napi_get_boolean(env, ok, &available);
  napi_set_named_property(env, result, "available", available);

  if (ok) {
    Sa3Api api;
    {
      std::lock_guard<std::mutex> lock(g_api_mutex);
      api = g_api;
    }
    napi_value version;
    const char* version_text = api.version ? api.version() : "";
    napi_create_string_utf8(env, version_text, NAPI_AUTO_LENGTH, &version);
    napi_set_named_property(env, result, "version", version);

    napi_value native_dir;
    napi_create_string_utf8(env, api.native_dir.c_str(), NAPI_AUTO_LENGTH, &native_dir);
    napi_set_named_property(env, result, "nativeDir", native_dir);
  } else {
    napi_value reason;
    napi_create_string_utf8(env, error.c_str(), NAPI_AUTO_LENGTH, &reason);
    napi_set_named_property(env, result, "reason", reason);
  }

  return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"generate", nullptr, generate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"convertLora", nullptr, convert_lora, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"diagnostics", nullptr, diagnostics, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

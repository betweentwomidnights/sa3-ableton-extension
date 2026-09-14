#include <node_api.h>

#include "libsa3_v1.h"
#include "wav.h"

#ifdef _WIN32
#  include <windows.h>
#else
#  include <dlfcn.h>
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
  std::string operation = "generate";
  double duration = 30.0;
  int steps = 8;
  int64_t seed = -1;
  float cfg_scale = 1.0f;
  float generation_tail_padding_sec = 6.0f;
  float continuation_tail_padding_sec = 6.0f;
  bool keep_models = false;
  std::string dist_shift = "LogSNR";

  std::string init_path;
  float init_noise_level = 0.85f;
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

using Sa3GetApiFn = const sa3_api_v1* (SA3_CALL *)(uint32_t);

struct Sa3Api {
#ifdef _WIN32
  HMODULE module = nullptr;
#else
  void* module = nullptr;
#endif
  const sa3_api_v1* api = nullptr;
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
  options.operation = get_string(env, value, "operation", options.operation);
  options.duration = get_double(env, value, "duration", options.duration);
  options.steps = get_int(env, value, "steps", options.steps);
  options.seed = get_int64(env, value, "seed", options.seed);
  options.cfg_scale = (float)get_double(env, value, "cfgScale", options.cfg_scale);
  options.generation_tail_padding_sec = (float)get_double(
    env, value, "generationTailPaddingSeconds", options.generation_tail_padding_sec);
  options.continuation_tail_padding_sec = (float)get_double(
    env, value, "continuationTailPaddingSeconds", options.continuation_tail_padding_sec);
  options.keep_models = get_bool(env, value, "keepModels", options.keep_models);
  options.dist_shift = get_string(env, value, "distShift", options.dist_shift);
  options.init_path = get_string(env, value, "initPath", "");
  options.init_noise_level = (float)get_double(env, value, "initNoiseLevel", options.init_noise_level);
  options.encode_chunk_size = get_int(env, value, "encodeChunkSize", options.encode_chunk_size);
  options.encode_overlap = get_int(env, value, "encodeOverlap", options.encode_overlap);
  options.decode_chunk_size = get_int(env, value, "decodeChunkSize", options.decode_chunk_size);
  options.decode_overlap = get_int(env, value, "decodeOverlap", options.decode_overlap);
  options.loras = get_loras(env, value);

  if (!std::isfinite(options.duration) || options.duration <= 0.0) {
    throw std::runtime_error("duration must be positive");
  }
  if (options.operation != "generate" && options.operation != "transform" && options.operation != "continue") {
    throw std::runtime_error("operation must be generate, transform, or continue");
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
#else
// POSIX (macOS): resolve the directory that holds this native addon so we can
// dlopen the co-bundled libsa3 dylib next to it. libsa3's ggml deps are wired
// with an @loader_path rpath by the packager, so they resolve from the same dir.
std::string module_directory_posix() {
  Dl_info info{};
  if (dladdr(reinterpret_cast<void*>(&module_directory_posix), &info) == 0 ||
      info.dli_fname == nullptr) {
    throw std::runtime_error("dladdr failed to locate the native addon path");
  }
  std::string path(info.dli_fname);
  size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) {
    throw std::runtime_error("native module path has no directory");
  }
  return path.substr(0, slash);
}
#endif

void* get_symbol(Sa3Api& api, const char* name) {
#ifdef _WIN32
  void* symbol = reinterpret_cast<void*>(GetProcAddress(api.module, name));
#else
  void* symbol = api.module ? dlsym(api.module, name) : nullptr;
#endif
  if (!symbol) {
    throw std::runtime_error(std::string("libsa3 is missing symbol ") + name);
  }
  return symbol;
}

bool load_sa3_api(std::string& error) {
  std::lock_guard<std::mutex> lock(g_api_mutex);
  if (g_api.module && g_api.api) return true;

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
    std::string dir = module_directory_posix();
    std::string dylib_path = dir + "/libsa3.dylib";
    void* module = dlopen(dylib_path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!module) {
      const char* reason = dlerror();
      error = "failed to load " + dylib_path + (reason ? std::string(": ") + reason : "");
      return false;
    }
    g_api.module = module;
    g_api.native_dir = dir;
#endif

    const auto get_api = reinterpret_cast<Sa3GetApiFn>(get_symbol(g_api, "sa3_get_api"));
    g_api.api = get_api(SA3_ABI_VERSION_1);
    if (!g_api.api || g_api.api->abi_version != SA3_ABI_VERSION_1 ||
        g_api.api->size < SA3_API_V1_MIN_SIZE) {
      throw std::runtime_error("libsa3 does not provide the complete C ABI V1 table");
    }
    return true;
  } catch (const std::exception& e) {
    error = e.what();
#ifdef _WIN32
    if (g_api.module) FreeLibrary(g_api.module);
#else
    if (g_api.module) dlclose(g_api.module);
#endif
    g_api = {};
    return false;
  }
}

// "cpu" forces the CPU backend through the V1 context config; anything else lets
// libsa3 pick a GPU (then fall back to CPU).
std::string normalized_device(const std::string& device) {
  return device == "cpu" ? "cpu" : "auto";
}

sa3_distribution_shift_v1 distribution_shift(const std::string& name) {
  if (name == "Flux") return SA3_DISTRIBUTION_FLUX_V1;
  if (name == "Full") return SA3_DISTRIBUTION_FULL_V1;
  if (name == "None") return SA3_DISTRIBUTION_NONE_V1;
  return SA3_DISTRIBUTION_LOGSNR_V1;
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

sa3_context* ensure_context(const GenerateOptions& options, Sa3Api& api, sa3_error_v1& error) {
  const std::string key = context_key(options);
  if (g_context && key == g_context_key) {
    return g_context;
  }

  if (g_context) {
    api.api->context_destroy(g_context);
    g_context = nullptr;
    g_context_key.clear();
  }

  sa3_context_config_v1 config = {};
  config.size = sizeof(config);
  api.api->context_config_init(&config);
  config.models_dir = options.models_dir.empty() ? nullptr : options.models_dir.c_str();
  config.adapters_dir = options.adapters_dir.empty() ? nullptr : options.adapters_dir.c_str();
  config.variant = options.variant.empty() ? nullptr : options.variant.c_str();
  config.dit_encoding = options.encoding.empty() ? nullptr : options.encoding.c_str();
  config.cpu_threads = options.cpu_threads;
  const std::string device = normalized_device(options.device);
  config.device = device == "cpu" ? "cpu" : nullptr;

  if (api.api->context_create(&config, &g_context, &error) != SA3_STATUS_OK_V1) {
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
void SA3_CALL progress_trampoline(void* user, const sa3_progress_v1* progress) {
  auto tsfn = static_cast<napi_threadsafe_function>(user);
  if (!tsfn || !progress) return;
  auto* msg = new ProgressMsg{progress->stage_name ? progress->stage_name : "",
                              progress->step, progress->total, (double)progress->fraction};
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

    std::vector<sa3_adapter_v1> adapters;
    adapters.reserve(work->options.loras.size());
    for (const auto& lora : work->options.loras) {
      sa3_adapter_v1 adapter = {};
      adapter.size = sizeof(adapter);
      api.api->adapter_init(&adapter);
      adapter.path_or_name = lora.name.c_str();
      adapter.strength = lora.strength;
      adapters.push_back(adapter);
    }

    sa3_request_v1 request = {};
    request.size = sizeof(request);
    api.api->request_init(&request);
    request.operation = work->options.operation == "transform" ? SA3_OPERATION_TRANSFORM_V1
                      : work->options.operation == "continue" ? SA3_OPERATION_CONTINUE_V1
                                                               : SA3_OPERATION_GENERATE_V1;
    request.prompt = work->options.prompt.c_str();
    request.negative_prompt = work->options.negative_prompt.empty()
      ? nullptr
      : work->options.negative_prompt.c_str();
    request.duration_seconds = work->options.duration;
    request.steps = work->options.steps > 0 ? work->options.steps : 8;
    request.seed = work->options.seed;
    request.cfg_scale = work->options.cfg_scale;
    request.generation_tail_padding_seconds = work->options.generation_tail_padding_sec;
    request.continuation_tail_padding_seconds = work->options.continuation_tail_padding_sec;
    request.residency = work->options.keep_models ? SA3_RESIDENCY_RESIDENT_V1 : SA3_RESIDENCY_FRUGAL_V1;
    request.distribution_shift = distribution_shift(work->options.dist_shift);
    request.adapters = adapters.empty() ? nullptr : adapters.data();
    request.adapter_count = (uint32_t)adapters.size();
    request.encode_chunk_size = work->options.encode_chunk_size;
    request.encode_overlap = work->options.encode_overlap;
    request.decode_chunk_size = work->options.decode_chunk_size;
    request.decode_overlap = work->options.decode_overlap;

    if (work->tsfn) {
      request.on_progress = progress_trampoline;
      request.callback_user = work->tsfn;
    }

    if (!init_audio.empty()) {
      request.input_audio.samples = init_audio.data();
      request.input_audio.n_samples = (uint64_t)init_samples;
      request.input_audio.n_channels = (uint32_t)init_channels;
      request.input_audio.sample_rate = (uint32_t)init_sample_rate;
      request.transform_noise_level = work->options.init_noise_level;
    }

    sa3_error_v1 error = {};
    error.size = sizeof(error);
    api.api->error_init(&error);
    sa3_result_v1 audio = {};
    audio.size = sizeof(audio);
    api.api->result_init(&audio);
    {
      std::lock_guard<std::mutex> lock(g_context_mutex);
      sa3_context* context = ensure_context(work->options, api, error);
      if (!context) {
        work->error = error.message[0] ? error.message : "sa3 context creation failed";
        return;
      }

      const sa3_status_v1 status = api.api->generate(context, &request, &audio, &error);
      if (status != SA3_STATUS_OK_V1) {
        work->error = error.message[0] ? error.message : "sa3 V1 generation failed";
        return;
      }
    }

    if (!audio.samples || audio.n_samples == 0 || audio.n_channels == 0 || audio.sample_rate == 0 ||
        audio.n_samples > (uint64_t)std::numeric_limits<int>::max() ||
        audio.n_channels > (uint32_t)std::numeric_limits<int>::max()) {
      api.api->result_free(&audio);
      work->error = "libsa3 returned invalid V1 audio";
      return;
    }
    const int output_samples = (int)audio.n_samples;
    work->wav_bytes = sa3::wav_planar_bytes(audio.samples, output_samples,
                                            (int)audio.n_channels, (int)audio.sample_rate);
    work->seed = audio.seed;
    work->sample_rate = (int)audio.sample_rate;
    work->channels = (int)audio.n_channels;
    work->samples = output_samples;
    api.api->result_free(&audio);
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

    sa3_lora_convert_v1 options = {};
    options.size = sizeof(options);
    api.api->lora_convert_init(&options);
    options.safetensors_path = work->options.safetensors_path.c_str();
    options.json_path = work->options.json_path.empty() ? nullptr : work->options.json_path.c_str();
    options.output_gguf_path = work->options.output_path.c_str();
    sa3_error_v1 error = {};
    error.size = sizeof(error);
    api.api->error_init(&error);
    const sa3_status_v1 status = api.api->convert_lora(&options, &error);
    if (status != SA3_STATUS_OK_V1) {
      work->error = error.message[0] ? error.message : "sa3 V1 LoRA conversion failed";
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
    const char* version_text = api.api && api.api->runtime_version ? api.api->runtime_version() : "";
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

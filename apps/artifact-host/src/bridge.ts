import {
  ARTIFACT_HEIGHT_MAX,
  ARTIFACT_HEIGHT_MIN,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_RESULT_TITLE_MAX,
} from "@openchat/contracts"

/**
 * The artifact-side half of the bridge: `window.openchat`, injected by the
 * tool's shell **before** the compiled app bundle (07-artifact-runtime.md
 * "Runtime API", 04-artifact-sandbox.md "Iframe bridge").
 *
 * The shim is a plain script, not a module, because it is inlined into one
 * portable HTML document. It carries no token, no cookie and no app API: its
 * only powers are reading its own `artifact:init` and posting four message
 * types back to the parent it was framed by.
 *
 * Identity rule: `artifact:init` is accepted only from `window.parent`, never
 * from `event.origin`. A sandboxed document without `allow-same-origin` has an
 * opaque origin, so `event.origin` is the string `"null"` — and so is every
 * other opaque frame's.
 *
 * The numeric caps are the viewer's, from `@openchat/contracts`: they are
 * interpolated here, so the emitted script and the viewer can never disagree.
 * The values are numbers, so they cannot introduce a `</script` terminator.
 */
export const BRIDGE_SCRIPT = `(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (window.openchat && typeof window.openchat.onInit === "function") return;

  var RESULT_MAX_BYTES = ${ARTIFACT_RESULT_MAX_BYTES};
  var TITLE_MAX = ${ARTIFACT_RESULT_TITLE_MAX};
  var RESIZE_MIN = ${ARTIFACT_HEIGHT_MIN};
  var RESIZE_MAX = ${ARTIFACT_HEIGHT_MAX};

  var state = { theme: "light", locale: "en", nonce: null, ready: false, height: null };
  var initHandlers = [];
  var root = null;
  var observer = null;
  var encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

  function post(message) {
    if (!state.nonce || !window.parent || window.parent === window) return false;
    try {
      window.parent.postMessage(message, "*");
      return true;
    } catch (error) {
      return false;
    }
  }

  function sizeOf(value) {
    try {
      var json = JSON.stringify(value);
      if (typeof json !== "string") return Infinity;
      return encoder ? encoder.encode(json).length : json.length;
    } catch (error) {
      return Infinity;
    }
  }

  function cleanResult(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    var cleaned = {};
    if ("title" in payload) {
      if (typeof payload.title !== "string") return null;
      // Code points, like the viewer: a UTF-16 slice can cut a surrogate pair.
      cleaned.title = Array.from(payload.title).slice(0, TITLE_MAX).join("");
    }
    if ("text" in payload) {
      if (typeof payload.text !== "string") return null;
      cleaned.text = payload.text;
    }
    if ("data" in payload) cleaned.data = payload.data;
    return cleaned;
  }

  function resize(px) {
    var height = Math.round(Number(px));
    if (!isFinite(height)) return false;
    if (height < RESIZE_MIN) height = RESIZE_MIN;
    if (height > RESIZE_MAX) height = RESIZE_MAX;
    state.height = height;
    if (!state.ready) return false;
    return post({ type: "artifact:resize", height: height, nonce: state.nonce });
  }

  function observeRoot() {
    root = document.getElementById("root");
    if (!root || observer || typeof ResizeObserver !== "function") return;
    observer = new ResizeObserver(function (entries) {
      var entry = entries && entries[entries.length - 1];
      if (!entry) return;
      if (entry.contentRect) resize(entry.contentRect.height);
      else if (typeof root.getBoundingClientRect === "function") {
        resize(root.getBoundingClientRect().height);
      }
    });
    observer.observe(root);
  }

  function fireInit() {
    var info = { theme: state.theme, locale: state.locale };
    var handlers = initHandlers.slice();
    initHandlers.length = 0;
    for (var index = 0; index < handlers.length; index += 1) {
      try {
        handlers[index](info);
      } catch (error) {
        /* an app that throws in onInit must not break the bridge */
      }
    }
  }

  function acceptInit(data) {
    if (typeof data.nonce !== "string" || data.nonce.length === 0) return false;
    state.nonce = data.nonce;
    state.theme = data.theme === "dark" ? "dark" : "light";
    state.locale = data.locale === "de" ? "de" : "en";
    state.ready = true;
    document.documentElement.setAttribute("data-theme", state.theme);
    document.documentElement.style.colorScheme = state.theme;
    post({ type: "artifact:ready", nonce: state.nonce });
    if (state.height !== null) {
      post({ type: "artifact:resize", height: state.height, nonce: state.nonce });
    } else if (root && typeof root.getBoundingClientRect === "function") {
      resize(root.getBoundingClientRect().height);
    }
    fireInit();
    return true;
  }

  window.addEventListener("message", function (event) {
    // Source, not origin; the parent is the only frame allowed to command us.
    if (!window.parent || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "artifact:init") {
      acceptInit(data);
      return;
    }
    if (data.type === "artifact:reset" && state.ready && data.nonce === state.nonce) {
      // Re-render from scratch without a new URL. The parent re-sends init on
      // the load event this produces.
      try {
        window.location.reload();
      } catch (error) {
        /* a reload may be blocked; the parent cannot tell and shows the frame as is */
      }
    }
  });

  var openchat = {
    get theme() {
      return state.theme;
    },
    get locale() {
      return state.locale;
    },
    onInit: function (fn) {
      if (typeof fn !== "function") return;
      if (state.ready) {
        try {
          fn({ theme: state.theme, locale: state.locale });
        } catch (error) {
          /* see fireInit */
        }
      } else {
        initHandlers.push(fn);
      }
    },
    result: function (payload) {
      if (!state.ready) return false;
      var cleaned = cleanResult(payload);
      if (!cleaned) return false;
      if (sizeOf(cleaned) > RESULT_MAX_BYTES) return false;
      var message = { type: "artifact:result", nonce: state.nonce };
      if ("title" in cleaned) message.title = cleaned.title;
      if ("text" in cleaned) message.text = cleaned.text;
      if ("data" in cleaned) message.data = cleaned.data;
      return post(message);
    },
    setHeight: function (px) {
      return resize(px);
    },
  };

  try {
    Object.defineProperty(window, "openchat", {
      value: openchat,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (error) {
    window.openchat = openchat;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeRoot);
  } else {
    observeRoot();
  }
})();`

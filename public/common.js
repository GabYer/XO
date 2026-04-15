window.XOCommon = (() => {
  const STORAGE_KEY = "xo-classic-online-session";
  const APP_ROUTES = new Set(["lobby", "room"]);

  function runtimeConfig() {
    return window.XO_RUNTIME || {};
  }

  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/$/, "");
  }

  function appBaseUrl() {
    const configuredBaseUrl = normalizeBaseUrl(runtimeConfig().baseUrl);
    if (configuredBaseUrl) {
      return `${configuredBaseUrl}/`;
    }

    const url = new URL(window.location.href);
    let pathname = url.pathname;
    const segments = pathname.split("/");
    const lastSegment = segments[segments.length - 1];

    if (!pathname.endsWith("/")) {
      if (lastSegment.includes(".") || APP_ROUTES.has(lastSegment)) {
        segments.pop();
        pathname = `${segments.join("/") || "/"}`;
      } else {
        pathname = `${pathname}/`;
      }
    }

    if (!pathname.endsWith("/")) {
      pathname = `${pathname}/`;
    }

    return `${url.origin}${pathname}`;
  }

  function apiBaseUrl() {
    const configuredApiBaseUrl = normalizeBaseUrl(runtimeConfig().apiBaseUrl);
    return configuredApiBaseUrl ? `${configuredApiBaseUrl}/` : appBaseUrl();
  }

  function buildPageUrl(page, params = {}) {
    const url = new URL(page, appBaseUrl());
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  }

  function buildApiUrl(pathname) {
    const cleanPath = String(pathname || "").replace(/^\/+/, "");
    return new URL(cleanPath, apiBaseUrl()).toString();
  }

  function saveSession(session) {
    if (!session) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (error) {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  async function apiRequest(pathname, options = {}) {
    let response;
    try {
      response = await fetch(buildApiUrl(pathname), {
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
    } catch (error) {
      throw new Error(
        "Ne udalos podklyuchitsya k API. Esli hosting staticheskiy, nuzhen otdelnyy backend ili apiBaseUrl v runtime-config.js.",
      );
    }

    const contentType = response.headers.get("Content-Type") || "";
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : {};

    if (!response.ok) {
      if (data.error) {
        throw new Error(data.error);
      }
      if (response.status === 404 || response.status === 405) {
        throw new Error("API ne nayden. Frontend zagruzilsya, no servernaya chast nedostupna.");
      }
      throw new Error(`Oshibka zaprosa (${response.status}).`);
    }

    return data;
  }

  async function copyText(value) {
    await navigator.clipboard.writeText(value);
  }

  return {
    buildApiUrl,
    buildPageUrl,
    saveSession,
    loadSession,
    clearSession,
    apiRequest,
    copyText,
  };
})();

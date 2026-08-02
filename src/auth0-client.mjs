export class Auth0ClientError extends Error {
  constructor(message, { code = "AUTH0_REQUEST_FAILED", status, cause } = {}) {
    super(message, { cause });
    this.name = "Auth0ClientError";
    this.code = code;
    this.status = status;
  }
}

export function createAuth0Client({
  baseUrl,
  clientId,
  clientSecret,
  realm,
  reservedOrigin,
  fetchFn = globalThis.fetch,
}) {
  const origin = normalizeAuth0BaseUrl(baseUrl);
  const forbiddenOrigin = normalizeReservedOrigin(reservedOrigin);
  if (origin === forbiddenOrigin) {
    throw new Auth0ClientError(
      "Auth0 origin conflicts with a reserved transport role",
      { code: "AUTH0_TRANSPORT_ROLE_CONFLICT" },
    );
  }
  requireNonEmptyString(clientId, "Auth0 client ID");
  requireNonEmptyString(clientSecret, "Auth0 client secret");
  requireNonEmptyString(realm, "Auth0 realm");
  if (typeof fetchFn !== "function") {
    throw new TypeError("Auth0 fetch capability is required");
  }

  async function request(pathname, init = {}) {
    const target = new URL(pathname, `${origin}/`);
    if (target.origin !== origin || target.username || target.password) {
      throw new Auth0ClientError(
        "Auth0 request escaped its configured origin",
        {
          code: "AUTH0_ORIGIN_VIOLATION",
        },
      );
    }

    const response = await fetchFn(target, { ...init, redirect: "manual" });
    if (response.url) {
      const responseUrl = new URL(response.url, target);
      if (responseUrl.origin !== origin) {
        await discardResponse(response);
        throw new Auth0ClientError(
          "Auth0 response escaped its configured origin",
          {
            code: "AUTH0_ORIGIN_VIOLATION",
            status: response.status,
          },
        );
      }
    }
    if (response.status >= 300 && response.status <= 399) {
      await discardResponse(response);
      throw new Auth0ClientError("Auth0 redirects are not permitted", {
        code: "AUTH0_REDIRECT_REFUSED",
        status: response.status,
      });
    }
    return response;
  }

  async function exchangePassword(username, password) {
    const tokenResponse = await request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "http://auth0.com/oauth/grant-type/password-realm",
        username,
        password,
        realm,
        scope: "openid profile email",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const token = await readJsonResponse(tokenResponse);
    if (!tokenResponse.ok) {
      throw new Auth0ClientError(
        token.error_description ??
          token.error ??
          `Auth0 token exchange failed: ${tokenResponse.status}`,
        { status: tokenResponse.status },
      );
    }
    if (
      typeof token.access_token !== "string" ||
      token.access_token.length === 0
    ) {
      throw new Auth0ClientError("Auth0 token response omitted access_token", {
        code: "AUTH0_MALFORMED_RESPONSE",
        status: tokenResponse.status,
      });
    }

    const userInfoResponse = await request("/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = await readJsonResponse(userInfoResponse);
    if (!userInfoResponse.ok) {
      throw new Auth0ClientError(
        profile.error_description ??
          profile.error ??
          `Auth0 userinfo failed: ${userInfoResponse.status}`,
        { status: userInfoResponse.status },
      );
    }

    return {
      token,
      user: {
        sub: profile.sub,
        name: profile.name ?? profile.email ?? "Authenticated User",
        email: profile.email ?? "",
        preferredUsername: profile.nickname ?? profile.email ?? "",
      },
    };
  }

  async function health() {
    const response = await request("/.well-known/openid-configuration");
    const ok = response.ok;
    await discardResponse(response);
    return ok;
  }

  return Object.freeze({ exchangePassword, health, origin });
}

function normalizeAuth0BaseUrl(value) {
  const url = new URL(String(value));
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError("Auth0 URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("Auth0 URL must not embed credentials");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.origin;
}

function normalizeReservedOrigin(value) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new TypeError("Reserved transport origin is required");
  }
  const url = new URL(String(value));
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError("Reserved transport origin must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("Reserved transport origin must not embed credentials");
  }
  return url.origin;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    const value = text ? JSON.parse(text) : {};
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    throw new Auth0ClientError("Auth0 returned malformed JSON", {
      code: "AUTH0_MALFORMED_RESPONSE",
      status: response.status,
    });
  }
}

async function discardResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The caller receives the bounded transport result or error.
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

// AIEF Quiz — Gemini AI Helper backend
// Vercel Serverless Function
//
// Features:
// - Gemini 3.8 Flash as primary model
// - Automatic retry for temporary errors (503/500/502/504/429)
// - Exponential backoff + jitter
// - Automatic fallback to Gemini 3.6 Flash
// - Keeps API key safely on the server
// - Supports chat history + system instruction

const PRIMARY_MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.6-flash";

// Number of total attempts for each model.
const PRIMARY_ATTEMPTS = 3;
const FALLBACK_ATTEMPTS = 2;

// Base delay for exponential backoff.
const BASE_DELAY_MS = 800;

// Errors that are normally temporary and worth retrying.
const RETRYABLE_STATUS_CODES = new Set([
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504  // Gateway Timeout
]);

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function getRetryDelay(attempt, response) {
  // If Google sends Retry-After, respect it when possible.
  const retryAfter = response?.headers?.get("retry-after");

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 8000);
    }
  }

  // Exponential backoff:
  // attempt 1 -> ~800ms
  // attempt 2 -> ~1600ms
  // attempt 3 -> ~3200ms
  //
  // Small random jitter prevents repeated requests from
  // hitting the API at exactly the same time.
  const exponentialDelay =
    BASE_DELAY_MS * Math.pow(2, attempt - 1);

  const jitter = Math.floor(Math.random() * 400);

  return exponentialDelay + jitter;
}

async function callGemini({
  apiKey,
  model,
  contents,
  systemInstruction
}) {
  const geminiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent";

  const requestBody = {
    contents: contents,
    generationConfig: {
      maxOutputTokens: 1200
    }
  };

  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [
        {
          text: systemInstruction
        }
      ]
    };
  }

  let lastResponse = null;
  let lastData = null;

  for (let attempt = 1; attempt <= arguments[0]?.attempts; attempt++) {
    try {
      const response = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(requestBody)
      });

      const responseText = await response.text();

      let data;

      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(
          `[AI HELPER] ${model} returned non-JSON response:`,
          responseText.slice(0, 500)
        );

        lastResponse = response;
        lastData = null;

        if (attempt < arguments[0]?.attempts) {
          const delay = getRetryDelay(attempt, response);

          console.warn(
            `[AI HELPER] ${model} invalid response. ` +
            `Retrying in ${delay}ms...`
          );

          await sleep(delay);
          continue;
        }

        break;
      }

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          data: data
        };
      }

      lastResponse = response;
      lastData = data;

      const shouldRetry =
        RETRYABLE_STATUS_CODES.has(response.status);

      if (!shouldRetry || attempt >= arguments[0]?.attempts) {
        break;
      }

      const delay = getRetryDelay(attempt, response);

      console.warn(
        `[AI HELPER] ${model} returned ${response.status}. ` +
        `Retry ${attempt + 1}/${arguments[0]?.attempts} ` +
        `in ${delay}ms.`
      );

      await sleep(delay);

    } catch (error) {
      console.error(
        `[AI HELPER] ${model} network error on attempt ${attempt}:`,
        error
      );

      if (attempt >= arguments[0]?.attempts) {
        return {
          ok: false,
          status: 500,
          data: {
            error: {
              message:
                error?.message ||
                "Network error while contacting Gemini."
            }
          }
        };
      }

      const delay =
        BASE_DELAY_MS * Math.pow(2, attempt - 1) +
        Math.floor(Math.random() * 400);

      console.warn(
        `[AI HELPER] ${model} network retry in ${delay}ms...`
      );

      await sleep(delay);
    }
  }

  return {
    ok: false,
    status: lastResponse?.status || 500,
    data: lastData
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only POST
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error(
        "[AI HELPER] GEMINI_API_KEY is missing."
      );

      return res.status(500).json({
        error:
          "Gemini API key is not configured on the server."
      });
    }

    const body = req.body || {};

    const message = body.message;

    const history = Array.isArray(body.history)
      ? body.history
      : [];

    const systemInstruction =
      typeof body.systemInstruction === "string"
        ? body.systemInstruction
        : "";

    if (
      !message ||
      typeof message !== "string" ||
      !message.trim()
    ) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    // Keep only valid recent conversation history.
    const safeHistory = history
      .slice(-20)
      .filter(function (item) {
        return (
          item &&
          (item.role === "user" ||
            item.role === "model" ||
            item.role === "assistant") &&
          typeof item.content === "string" &&
          item.content.trim()
        );
      });

    const contents = [];

    for (const item of safeHistory) {
      contents.push({
        role:
          item.role === "assistant"
            ? "model"
            : item.role,
        parts: [
          {
            text: item.content
          }
        ]
      });
    }

    // Add the current user message.
    contents.push({
      role: "user",
      parts: [
        {
          text: message.trim()
        }
      ]
    });

    // -------------------------------------------------------
    // 1. PRIMARY MODEL
    // -------------------------------------------------------

    console.log(
      `[AI HELPER] Trying primary model: ${PRIMARY_MODEL}`
    );

    const primaryResult = await callGemini({
      apiKey,
      model: PRIMARY_MODEL,
      contents,
      systemInstruction,
      attempts: PRIMARY_ATTEMPTS
    });

    if (primaryResult.ok) {
      const answer =
        primaryResult.data?.candidates?.[0]?.content?.parts
          ?.map(function (part) {
            return part?.text || "";
          })
          .join("")
          .trim();

      if (answer) {
        console.log(
          `[AI HELPER] Success with ${PRIMARY_MODEL}`
        );

        return res.status(200).json({
          answer: answer,
          model: PRIMARY_MODEL
        });
      }

      console.warn(
        `[AI HELPER] ${PRIMARY_MODEL} returned empty response.`
      );
    }

    // -------------------------------------------------------
    // 2. FALLBACK MODEL
    // -------------------------------------------------------

    console.warn(
      `[AI HELPER] Primary model failed. ` +
      `Switching to fallback model: ${FALLBACK_MODEL}`
    );

    const fallbackResult = await callGemini({
      apiKey,
      model: FALLBACK_MODEL,
      contents,
      systemInstruction,
      attempts: FALLBACK_ATTEMPTS
    });

    if (fallbackResult.ok) {
      const answer =
        fallbackResult.data?.candidates?.[0]?.content?.parts
          ?.map(function (part) {
            return part?.text || "";
          })
          .join("")
          .trim();

      if (answer) {
        console.log(
          `[AI HELPER] Success with fallback ${FALLBACK_MODEL}`
        );

        return res.status(200).json({
          answer: answer,
          model: FALLBACK_MODEL
        });
      }

      console.error(
        `[AI HELPER] Fallback model returned empty response.`
      );
    }

    // -------------------------------------------------------
    // 3. BOTH MODELS FAILED
    // -------------------------------------------------------

    const primaryError =
      primaryResult.data?.error?.message ||
      "Primary Gemini model failed.";

    const fallbackError =
      fallbackResult.data?.error?.message ||
      "Fallback Gemini model failed.";

    console.error(
      "[AI HELPER] Both Gemini models failed.",
      {
        primaryStatus: primaryResult.status,
        primaryError,
        fallbackStatus: fallbackResult.status,
        fallbackError
      }
    );

    // Give the frontend a useful error.
    // 503 is used when Gemini capacity/service is unavailable.
    const finalStatus =
      fallbackResult.status === 503 ||
      primaryResult.status === 503
        ? 503
        : fallbackResult.status || primaryResult.status || 500;

    return res.status(finalStatus).json({
      error:
        "AI service is temporarily unavailable. " +
        "Please try again in a moment."
    });

  } catch (error) {
    console.error(
      "[AI HELPER] Backend error:",
      error
    );

    return res.status(500).json({
      error: "AI Helper server error."
    });
  }
}

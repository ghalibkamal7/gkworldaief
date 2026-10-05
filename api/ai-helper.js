```js
// AIEF Quiz — Gemini AI Helper backend
// Deploy this file as a Vercel Serverless Function.
//
// IMPORTANT:
// Do NOT put GEMINI_API_KEY in this file.
// Add GEMINI_API_KEY as an environment variable in your hosting provider.

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Gemini API key is not configured on the server."
    });
  }

  try {
    const {
      message,
      history = [],
      systemInstruction = ""
    } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    // Keep the request size reasonable.
    const safeHistory = Array.isArray(history)
      ? history.slice(-20)
      : [];

    const contents = [
      ...safeHistory
        .filter(
          item =>
            item &&
            (item.role === "user" || item.role === "model") &&
            typeof item.content === "string"
        )
        .map(item => ({
          role: item.role,
          parts: [{ text: item.content }]
        })),

      {
        role: "user",
        parts: [{ text: message }]
      }
    ];

    const model = "gemini-2.5-flash";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...(systemInstruction
            ? {
                systemInstruction: {
                  parts: [{ text: systemInstruction }]
                }
              }
            : {}),

          contents,

          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1200
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Gemini API request failed."
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || "")
        .join("")
        .trim();

    if (!answer) {
      return res.status(502).json({
        error: "Gemini returned an empty response."
      });
    }

    return res.status(200).json({
      answer
    });

  } catch (error) {
    console.error("AI Helper backend error:", error);

    return res.status(500).json({
      error: "AI Helper server error."
    });
  }
}
```


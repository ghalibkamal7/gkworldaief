// AIEF Quiz — Gemini AI Helper backend
// Vercel Serverless Function

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
      console.error("GEMINI_API_KEY is missing");

      return res.status(500).json({
        error: "Gemini API key is not configured on the server."
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

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    // Keep only recent conversation history
    const safeHistory = history
      .slice(-20)
      .filter(function (item) {
        return (
          item &&
          (item.role === "user" || item.role === "model") &&
          typeof item.content === "string"
        );
      });

    const contents = [];

    for (const item of safeHistory) {
      contents.push({
        role: item.role,
        parts: [
          {
            text: item.content
          }
        ]
      });
    }

    contents.push({
      role: "user",
      parts: [
        {
          text: message
        }
      ]
    });

    // Current Gemini model
    const model = "gemini-3.8-flash";

    const geminiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);

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

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await geminiResponse.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error(
        "Gemini returned non-JSON response:",
        responseText.slice(0, 500)
      );

      return res.status(502).json({
        error: "Invalid response received from Gemini."
      });
    }

    if (!geminiResponse.ok) {
      console.error("Gemini API error:", data);

      return res.status(geminiResponse.status).json({
        error:
          data?.error?.message ||
          "Gemini API request failed."
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts
        ?.map(function (part) {
          return part?.text || "";
        })
        .join("")
        .trim();

    if (!answer) {
      console.error("Gemini returned no answer:", data);

      return res.status(502).json({
        error: "Gemini returned an empty response."
      });
    }

    return res.status(200).json({
      answer: answer
    });

  } catch (error) {
    console.error("AI Helper backend error:", error);

    return res.status(500).json({
      error: "AI Helper server error."
    });
  }
}


export async function onRequestPost({ request, env }) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  try {
    // Require a valid registered account session before any Gemini request.
    const cookieHeader = request.headers.get("Cookie") || "";
    const sessionCookie = cookieHeader.split(";").map(part => part.trim()).find(part => part.startsWith("apnaai_session="));
    const sessionToken = sessionCookie ? decodeURIComponent(sessionCookie.slice("apnaai_session=".length)) : "";
    if (!sessionToken || !env.AUTH_DB) {
      return Response.json({ error: "AI use karne ke liye pehle ApnaAI account banayein ya login karein.", code: "AUTH_REQUIRED" }, { status: 401, headers });
    }
    const tokenDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
    const tokenHash = [...new Uint8Array(tokenDigest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const account = await env.AUTH_DB.prepare(
      "SELECT users.id FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?"
    ).bind(tokenHash, Date.now()).first();
    if (!account) {
      return Response.json({ error: "AI use karne ke liye pehle ApnaAI account banayein ya login karein.", code: "AUTH_REQUIRED" }, { status: 401, headers });
    }

    if (!env.GEMINI_API_KEY) {
      return Response.json(
        { error: "AI service is not configured." },
        { status: 500, headers }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid request. Please send valid JSON." },
        { status: 400, headers }
      );
    }

    const prompt = typeof body?.prompt === "string"
      ? body.prompt.trim()
      : "";
    const tool = typeof body?.tool === "string" && body.tool.trim()
      ? body.tool.trim()
      : "AI Assistant";

    if (!prompt || prompt.length > 3000) {
      return Response.json(
        { error: "Please enter text up to 3000 characters." },
        { status: 400, headers }
      );
    }

    const allowedTools = [
      "AI Assistant",
      "AI Text Writer",
      "Caption Generator",
      "CV Maker",
      "Email Writer",
      "Product Description",
      "Translator",
      "Study Assistant",
      "Bio Generator"
    ];

    if (!allowedTools.includes(tool)) {
      return Response.json(
        { error: "Unknown AI tool." },
        { status: 400, headers }
      );
    }

    const instructions = `
You are ApnaAI, a helpful multilingual assistant.
Selected tool: ${tool}.
Understand the user's request and produce a useful result.
Reply in the same language as the user's request:
English, Urdu, or Roman Urdu.
Be clear, helpful and accurate.
User request: ${prompt}
`;

    const apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: instructions }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1000
        }
      })
    };

    // Retry temporary Gemini capacity/server errors. Do not retry exhausted daily quota.
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(apiUrl, requestOptions);

      if (response.ok) break;

      const retryData = await response.clone().json().catch(() => ({}));
      const providerMessage = retryData.error?.message || "";
      const isDailyQuota = response.status === 429 &&
        /free.?tier|per.?day|requests per day|quota exceeded/i.test(providerMessage);
      const isTemporary = [500, 502, 503, 504].includes(response.status) ||
        (response.status === 429 && !isDailyQuota);

      if (!isTemporary || attempt === 2) break;

      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }

    let data;
    try {
      data = await response.json();
    } catch {
      console.error("Gemini returned a non-JSON response:", response.status);
      return Response.json(
        { error: "AI provider returned an invalid response. Please try again." },
        { status: 502, headers }
      );
    }

    if (!response.ok) {
      console.error("Gemini API error:", response.status, data);

      if (response.status === 429) {
        const retryInfo = data.error?.details?.find(
          item => item["@type"]?.includes("RetryInfo")
        );
        const retryDelay = retryInfo?.retryDelay;

        return Response.json(
          {
            error: "ApnaAI ki aaj ki free AI request limit poori ho gayi hai. Google Gemini quota reset hone ke baad dobara try karein, ya administrator paid API billing enable kare."
          },
          {
            status: 429,
            headers: {
              ...headers,
              ...(retryDelay ? { "Retry-After": String(Math.ceil(parseFloat(retryDelay) || 0)) } : {})
            }
          }
        );
      }

      if ([500, 502, 503, 504].includes(response.status) ||
          (response.status === 429 && !/free.?tier|per.?day|requests per day|quota exceeded/i.test(data.error?.message || ""))) {
        return Response.json(
          {
            error: "Google Gemini is busy right now. ApnaAI ne dobara koshish ki, lekin service abhi available nahi. 1-2 minute baad phir try karein."
          },
          { status: 503, headers }
        );
      }

      return Response.json(
        {
          error: "Gemini API error",
          details: data.error?.message || "Unknown provider error",
          status: response.status
        },
        { status: 502, headers }
      );
    }

    const answer =
      data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!answer) {
      console.error("Gemini response contained no text:", {
        finishReason: data.candidates?.[0]?.finishReason,
        promptFeedback: data.promptFeedback
      });
      return Response.json(
        { error: "No answer received. Please try again." },
        { status: 502, headers }
      );
    }

    return Response.json({ answer }, { headers });

  } catch (error) {
    console.error("ApnaAI generate endpoint failed:", error);
    return Response.json(
      { error: "Something went wrong. Please try again." },
      { status: 500, headers }
    );
  }
}

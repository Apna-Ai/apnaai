
export async function onRequestPost({ request, env }) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  try {
    if (!env.GEMINI_API_KEY) {
      return Response.json(
        { error: "AI service is not configured." },
        { status: 500, headers }
      );
    }

    const body = await request.json();
    const prompt = typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";
    const tool = typeof body.tool === "string"
      ? body.tool
      : "AI Assistant";

    if (!prompt || prompt.length > 3000) {
      return Response.json(
        { error: "Please enter text up to 3000 characters." },
        { status: 400, headers }
      );
    }

    const allowedTools = [
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

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
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
      }
    );

    const data = await response.json();

   if (!response.ok) {
  console.error("Gemini API error:", response.status, data);

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
      return Response.json(
        { error: "No answer received. Please try again." },
        { status: 502, headers }
      );
    }

    return Response.json({ answer }, { headers });

  } catch (error) {
    return Response.json(
      { error: "Something went wrong. Please try again." },
      { status: 500, headers }
    );
  }
}

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export default {
  fetch(request: Request) {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: {
          ...jsonHeaders,
          Allow: "GET",
        },
      });
    }

    return new Response(JSON.stringify({ ok: true, runtime: "vercel" }), {
      status: 200,
      headers: jsonHeaders,
    });
  },
};

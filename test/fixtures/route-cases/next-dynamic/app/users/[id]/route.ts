// Next.js App Router dynamic route for /users/[id] (file-convention route).
export function GET(req, { params }) {
  return Response.json({ id: params.id });
}

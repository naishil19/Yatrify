export default function handler(_req, res) {
  res.status(200).json({ ok: true, message: "Yatrify API is live" });
}

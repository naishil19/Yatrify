function getCreditPackConfig() {
  const credits = Number(process.env.RAZORPAY_CREDIT_PACK_CREDITS || 5);
  const amountSubunits = Number.parseInt(
    String(process.env.RAZORPAY_CREDIT_PACK_AMOUNT || "25000"),
    10
  );
  const currency = String(process.env.RAZORPAY_CREDIT_PACK_CURRENCY || "INR")
    .trim()
    .toUpperCase();

  return {
    credits: Number.isFinite(credits) && credits > 0 ? credits : 5,
    amountSubunits:
      Number.isInteger(amountSubunits) && amountSubunits > 0 ? amountSubunits : 25000,
    currency: currency || "INR",
  };
}

export default function handler(_req, res) {
  return res.json({
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    apiBaseUrl: process.env.API_BASE_URL || "",
    razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || "").trim(),
    creditPack: getCreditPackConfig(),
  });
}

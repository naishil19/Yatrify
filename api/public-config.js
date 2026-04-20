export default function handler(_req, res) {
  res.status(200).json({
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    apiBaseUrl: process.env.API_BASE_URL || "https://yatrify-ai.vercel.app",
    creditPack: {
      credits: Number(process.env.RAZORPAY_CREDIT_PACK_CREDITS || 5),
      amountSubunits: Number(process.env.RAZORPAY_CREDIT_PACK_AMOUNT || 25000),
      currency: String(process.env.RAZORPAY_CREDIT_PACK_CURRENCY || "INR").toUpperCase(),
    },
  });
}

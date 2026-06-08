// Vercel Serverless Function — sends a guest's QR code by email via Resend.
//
// SETUP (do this in Vercel + Resend, explained in the guide):
//   1. Get a Resend API key at resend.com
//   2. Verify your sending domain (e.g. ipridesoftball.org) in Resend
//   3. In Vercel → your project → Settings → Environment Variables, add:
//        RESEND_API_KEY   = your Resend key (starts with "re_")
//        FROM_EMAIL       = it@ipridesoftball.org   (an address on your verified domain)
//   4. Redeploy.
//
// The QR image is sent as an inline attachment and shown in the email body.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL;

  // If the service isn't configured yet, tell the app so it can fall back to Mail.
  if (!apiKey || !fromEmail) {
    res.status(501).send("Email service not configured (missing RESEND_API_KEY or FROM_EMAIL)");
    return;
  }

  try {
    const { to, name, token, qrPng, table, seat } = req.body || {};
    if (!to || !qrPng) {
      res.status(400).send("Missing 'to' or 'qrPng'");
      return;
    }

    // Strip the data-URL prefix to get raw base64 for the attachment.
    const base64 = String(qrPng).replace(/^data:image\/png;base64,/, "");

    const seatLine = table
      ? `<p style="margin:0 0 4px"><strong>Your seat:</strong> ${table}${seat ? `, Seat ${seat}` : ""}</p>`
      : "";

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222">
        <h2 style="margin:0 0 12px">You're confirmed!</h2>
        <p style="margin:0 0 8px">Hi ${name || "there"},</p>
        <p style="margin:0 0 12px">Please present this QR code at check-in:</p>
        ${seatLine}
        <div style="text-align:center;margin:18px 0">
          <img src="cid:qrcode" alt="Your QR code" width="220" height="220"
               style="border:1px solid #eee;border-radius:8px"/>
        </div>
        <p style="margin:0;color:#666;font-size:12px">Code ID: ${token || ""}</p>
        <p style="margin:16px 0 0">See you there!</p>
      </div>`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: "Your Event Check-In QR Code",
        html,
        attachments: [
          {
            filename: "qr-code.png",
            content: base64,
            content_id: "qrcode", // matches cid:qrcode above so it shows inline
          },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      res.status(502).send("Resend error: " + errText);
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).send("Server error: " + (e?.message || String(e)));
  }
}

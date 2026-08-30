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
      ? `<div style="background:#faf5ea;border:1px solid #e8d9b0;border-radius:10px;padding:14px 18px;margin:0 0 20px;text-align:center">
           <div style="font-size:12px;letter-spacing:2px;color:#9a7b3a;text-transform:uppercase;margin-bottom:4px">Your Seat</div>
           <div style="font-size:20px;font-weight:700;color:#1a1a1a">${table}${seat ? ` &middot; Seat ${seat}` : ""}</div>
         </div>`
      : "";

    const html = `
      <div style="margin:0;padding:0;background:#0e1117">
        <div style="font-family:Georgia,'Times New Roman',serif;max-width:520px;margin:0 auto;background:#141821;border-radius:16px;overflow:hidden;border:1px solid #2a2f3a">

          <!-- Header -->
          <div style="background:linear-gradient(135deg,#1a1f2b,#0e1117);padding:34px 24px 26px;text-align:center;border-bottom:2px solid #d4af6a">
            <div style="font-size:12px;letter-spacing:4px;color:#d4af6a;text-transform:uppercase;margin-bottom:10px;font-family:Arial,sans-serif">NAGAAA &middot; Est. 1997</div>
            <div style="font-size:26px;font-weight:700;color:#f5e9cf;line-height:1.25">Hall of Fame Dinner<br/><span style="color:#d4af6a;font-style:italic">&amp;</span> iPride Honors</div>
          </div>

          <!-- Body -->
          <div style="padding:30px 30px 34px;font-family:Arial,sans-serif;color:#e6e9ef">
            <p style="font-size:18px;margin:0 0 6px;color:#f5e9cf;font-family:Georgia,serif">You're on the list, ${name || "friend"}! 🎉</p>
            <p style="font-size:15px;line-height:1.55;margin:0 0 22px;color:#aeb6c2">
              We can't wait to celebrate with you. This is your personal check-in pass, just have it ready on your phone when you arrive and we'll get you to your seat in seconds.
            </p>

            ${seatLine}

            <!-- Event details: when & where -->
            <div style="background:#11151d;border:1px solid #2a2f3a;border-radius:10px;padding:16px 18px;margin:0 0 20px">
              <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif">
                <tr>
                  <td style="padding:0 0 10px;vertical-align:top;width:70px;color:#d4af6a;font-size:12px;letter-spacing:1px;text-transform:uppercase">When</td>
                  <td style="padding:0 0 10px;vertical-align:top;color:#e6e9ef;font-size:14px">Happy Hour begins at 5:30 PM</td>
                </tr>
                <tr>
                  <td style="padding:0;vertical-align:top;color:#d4af6a;font-size:12px;letter-spacing:1px;text-transform:uppercase">Where</td>
                  <td style="padding:0;vertical-align:top;color:#e6e9ef;font-size:14px">
                    Columbus Museum of Art<br/>
                    <span style="color:#aeb6c2">480 E Broad St, Columbus, OH 43215</span><br/>
                    <a href="https://maps.google.com/?q=Columbus+Museum+of+Art+480+E+Broad+St+Columbus+OH+43215" style="color:#d4af6a;font-size:13px;text-decoration:underline">Get directions</a>
                  </td>
                </tr>
              </table>
            </div>

            <div style="text-align:center;margin:8px 0 6px">
              <div style="display:inline-block;background:#ffffff;padding:16px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.35)">
                <img src="cid:qrcode" alt="Your check-in QR code" width="220" height="220" style="display:block"/>
              </div>
            </div>
            <p style="text-align:center;margin:14px 0 0;color:#7f8794;font-size:11px;font-family:Arial,sans-serif">Check-in code: ${token || ""}</p>

            <div style="margin:26px 0 0;padding:16px 18px;background:#11151d;border-radius:10px;border-left:3px solid #d4af6a">
              <p style="margin:0;font-size:13px;line-height:1.5;color:#aeb6c2;font-family:Arial,sans-serif">
                <strong style="color:#d4af6a">Tip:</strong> Save this email or screenshot the code so it's handy at the door. One quick scan and you're in.
              </p>
            </div>

            <p style="margin:26px 0 0;font-size:16px;color:#f5e9cf;font-family:Georgia,serif;text-align:center">See you there! ✨</p>
          </div>

          <!-- Footer -->
          <div style="background:#0e1117;padding:18px 24px;text-align:center;border-top:1px solid #2a2f3a">
            <p style="margin:0;color:#6b7280;font-size:11px;font-family:Arial,sans-serif">iPride Softball &middot; Hall of Fame Dinner &amp; iPride Honors</p>
          </div>

        </div>
      </div>`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `iPride Honors <${fromEmail}>`,
        to: [to],
        subject: "Here's your ticket to the Hall of Fame Dinner & iPride Honors 🎟️",
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

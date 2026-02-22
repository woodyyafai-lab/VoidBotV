# 🚀 Void Management Bot – Deployment Guide
## Twilio WhatsApp + Railway Hosting

---

## STEP 1 — Get your Anthropic API Key

1. Go to https://console.anthropic.com
2. Click **API Keys** → **Create Key**
3. Copy and save it — you'll need it later

---

## STEP 2 — Set up Twilio WhatsApp Sandbox

1. Go to https://twilio.com and sign up (free)
2. In the Console, go to **Messaging → Try it out → Send a WhatsApp message**
3. Follow the instructions to join the sandbox:
   - You'll send a code like `join <word-word>` to a Twilio WhatsApp number
   - Every team member needs to do this once to use the bot
4. Note down your:
   - **Account SID** (starts with AC...)
   - **Auth Token**
   - **Twilio WhatsApp number** (e.g. whatsapp:+14155238886)

---

## STEP 3 — Get your Firebase Service Account Key

1. Go to https://console.firebase.google.com
2. Open your **whatsapp-bot-6a12f** project
3. Click ⚙️ **Project Settings** → **Service Accounts**
4. Click **Generate new private key** → **Generate Key**
5. A JSON file will download — keep this safe!
6. Open the file and copy ALL the contents

---

## STEP 4 — Deploy to Railway (free hosting)

1. Go to https://railway.app and sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
   - OR click **New Project** → **Empty Project** → drag your folder in
3. Once deployed, go to your project → **Variables** tab
4. Add these environment variables one by one:

   | Variable | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | Your Twilio Account SID |
   | `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token |
   | `ANTHROPIC_API_KEY` | Your Anthropic API key |
   | `FIREBASE_SERVICE_ACCOUNT` | Paste the full JSON contents from Step 3 |

5. Railway will auto-deploy. Click your deployment to get your **public URL**
   - It will look like: `https://valor-bot-production.up.railway.app`

---

## STEP 5 — Connect Twilio to your server

1. Go back to Twilio Console
2. Go to **Messaging → Settings → WhatsApp Sandbox Settings**
3. In the field **"When a message comes in"**, paste your Railway URL + `/webhook`:
   ```
   https://valor-bot-production.up.railway.app/webhook
   ```
4. Set the method to **HTTP POST**
5. Click **Save**

---

## STEP 6 — Test it!

1. Open WhatsApp on your phone
2. Send a message to your Twilio sandbox number
3. Try: *"Show all void properties"*
4. The bot should reply within a few seconds ✅

---

## Adding More Team Members

Each staff member needs to join the Twilio sandbox once:
1. Save the Twilio WhatsApp number in their phone
2. Send the join code (e.g. `join bright-tiger`) to that number
3. They're in! All their messages go to the same Firebase database

---

## Going Live (Optional Upgrade)

The sandbox is free but requires the join code step.
To remove that restriction and get a dedicated business number:
- Apply for **WhatsApp Business API** approval through Twilio (~£1/month)
- This takes 1-3 business days for Meta to approve

---

## Need Help?

If you get stuck on any step, take a screenshot and share it — happy to help! 🙂

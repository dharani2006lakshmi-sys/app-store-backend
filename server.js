import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Client, StorageMemory } from "@mtkruto/node";


dotenv.config();

const app = express();
app.use(express.json());

// Allow ALL origins automatically (fixes Vercel CORS issues)
app.use(cors());


const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || "31654968");
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "b00f22e26a8c38db4172ce84f7d96ae2";

const mtprotoClient = new Client({
  storage: new StorageMemory(),
  apiId: TELEGRAM_API_ID,
  apiHash: TELEGRAM_API_HASH
});

// Start MTProto client
(async () => {
  try {
    await mtprotoClient.start({ botToken: TELEGRAM_BOT_TOKEN });
    console.log("MTKruto Client connected securely to Telegram!");

// Phase 3: Telegram Auto-Upload Bot & Caption Parser
mtprotoClient.on("message", async (ctx) => {
  try {
    const msg = ctx.message || ctx.msg || ctx; // handle different MTKruto context structures
    if (msg && msg.document) {
      const doc = msg.document;
      const fileName = doc.fileName || doc.file_name || "unknown.apk";
      if (!fileName.toLowerCase().endsWith('.apk')) return;
      
      let appName = fileName.replace(/\.apk$/i, '').replace(/_/g, ' ').replace(/-/g, ' ') + " (Auto-Uploaded)";
      let version = "1.0";
      let description = "Auto-uploaded from Telegram. Please edit details.";
      let changelog = "Initial release";

      // Parse caption if available
      const caption = msg.caption || "";
      if (caption) {
        const lines = caption.split("\n").map(l => l.trim()).filter(l => l);
        if (lines.length > 0) {
          const firstLine = lines[0];
          const vMatch = firstLine.match(/v\d+(\.\d+)*/i);
          if (vMatch) {
            version = vMatch[0].replace(/v/i, '');
            appName = firstLine.replace(vMatch[0], '').trim();
          } else {
            appName = firstLine;
          }
          
          if (lines.length > 1) {
            description = lines.slice(1).join("\n");
            changelog = "Updated from Telegram post";
          }
        }
      }

      console.log(`Auto-uploading parsed app: ${appName} v${version}`);
      
      const { data: newApp, error: appErr } = await supabase.from("apps").insert([{
        name: appName,
        description: description,
        version: version,
        is_published: false
      }]).select().single();
      
      if (appErr) return console.error(appErr);
      
      const fileId = doc.fileId || doc.file_id || doc.id;
      
      await supabase.from("app_links").insert([{
        app_id: newApp.id,
        telegram_file_id: fileId,
        file_name: fileName,
        label: `Version ${version}`,
        changelog: changelog,
        sort_order: 0
      }]);
      
      await mtprotoClient.sendMessage(ctx.chat.id, `✅ Success! Automatically added **${appName}** (v${version}) to your App Store! Check your Admin Panel to publish it.`);
    }
  } catch(e) {
    console.error("Auto-upload error:", e);
  }
});

  } catch (e) {
    console.error("Failed to connect MTKruto client:", e);
  }
})();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =========================================================
// HEALTH CHECK
// =========================================================
app.get("/", (req, res) => {
  res.send("App Store backend is running.");
});

// =========================================================
// PUBLIC: Get all categories with their published apps + links
// =========================================================
app.get("/api/apps", async (req, res) => {
  try {
    const { data: categories, error: catErr } = await supabase
      .from("categories")
      .select("id, name, sort_order")
      .order("sort_order", { ascending: true });

    if (catErr) throw catErr;

    const { data: apps, error: appErr } = await supabase
      .from("apps")
      .select("id, name, description, icon_url, version, category_id, sort_order, downloads, created_at, updated_at")
      .eq("is_published", true)
      .order("sort_order", { ascending: true });

    if (appErr) throw appErr;

    const { data: links, error: linkErr } = await supabase
      .from("app_links")
      .select("id, app_id, label, file_name, sort_order, changelog")
      .order("sort_order", { ascending: true });

    if (linkErr) throw linkErr;

    // attach links to their app
    const appsWithLinks = apps.map((a) => ({
      ...a,
      links: links
        .filter((l) => l.app_id === a.id)
        .map((l) => ({ id: l.id, label: l.label, file_name: l.file_name, changelog: l.changelog })),
    }));

    // group apps under categories
    const result = categories.map((cat) => ({
      ...cat,
      apps: appsWithLinks.filter((a) => a.category_id === cat.id),
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// PUBLIC: Download a file by app_links.id
// Streams the file from Telegram so the user never sees
// Telegram's domain.
// =========================================================
app.get("/download/:linkId", async (req, res) => {
  try {
    const { linkId } = req.params;

    const { data: link, error } = await supabase
      .from("app_links")
      .select("telegram_file_id, file_name, app_id")
      .eq("id", linkId)
      .single();

    if (error || !link) {
      return res.status(404).send("File not found");
    }

    const fileName = link.file_name || "app.apk";
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    // Use MTKruto to bypass 20MB limit
    // Get file size
    try {
      // MTKruto handles bot file IDs natively
      for await (const chunk of mtprotoClient.download(link.telegram_file_id)) {
        res.write(chunk);
      }
      res.end();
      
      // Enforce Unique Downloads based on IP
      if (link.app_id) {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        supabase.from("download_logs").insert([{ app_id: link.app_id, ip_address: ip }])
          .then(({ error }) => {
            if (!error) {
              // Unique download detected, increment the count!
              supabase.rpc("increment_downloads", { row_id: link.app_id }).catch(console.error);
            } else if (error.code !== '23505') { 
              // 23505 is the Postgres Unique Violation code (already downloaded)
              console.error("Error logging unique download:", error);
            }
          });
      }
    } catch (downloadErr) {
      console.error("MTKruto Download Error:", downloadErr);
      throw downloadErr;
    }

  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).send("Server error: " + err.message);
    } else {
      res.end();
    }
  }
});

// =========================================================

// =========================================================
// PHASE 2: COMMUNITY ROUTES (Reviews & Requests)
// =========================================================
app.get("/api/reviews/:app_id", async (req, res) => {
  const { data, error } = await supabase
    .from("app_reviews")
    .select("*")
    .eq("app_id", req.params.app_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/reviews", async (req, res) => {
  const { app_id, rating, comment } = req.body;
  const { error } = await supabase.from("app_reviews").insert([{ app_id, rating, comment }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post("/api/requests", async (req, res) => {
  const { app_name, reason } = req.body;
  const { error } = await supabase.from("app_requests").insert([{ app_name, reason }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get("/api/admin/requests", requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("app_requests").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/admin/requests/:id", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("app_requests").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ADMIN: Routes below require a valid Supabase access token
// (sent as: Authorization: Bearer <token>)
// =========================================================
async function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");

  if (!token) return res.status(401).json({ error: "Missing token" });

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  req.user = data.user;
  next();
}

// Get ALL apps (including unpublished) for admin panel
app.get("/api/admin/apps", requireAdmin, async (req, res) => {
  const { data: apps, error } = await supabase
    .from("apps")
    .select("*, app_links(*)")
    .order("sort_order", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(apps);
});

// Get categories (admin)
app.get("/api/admin/categories", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Create / update / delete categories
app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("categories").insert(req.body).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("categories")
    .update(req.body)
    .eq("id", req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("categories").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Create app
app.post("/api/admin/apps", requireAdmin, async (req, res) => {
  const { links, ...appData } = req.body;

  const { data: app, error } = await supabase.from("apps").insert(appData).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (links && links.length > 0) {
    const linkRows = links.map((l, idx) => ({ ...l, app_id: app.id, sort_order: idx }));
    const { error: linkErr } = await supabase.from("app_links").insert(linkRows);
    if (linkErr) return res.status(500).json({ error: linkErr.message });
  }

  res.json(app);
});

// Update app (metadata, description, category, publish toggle)
app.put("/api/admin/apps/:id", requireAdmin, async (req, res) => {
  const { links, ...appData } = req.body;
  appData.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("apps")
    .update(appData)
    .eq("id", req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });

  // Replace links if provided
  if (links) {
    await supabase.from("app_links").delete().eq("app_id", req.params.id);
    if (links.length > 0) {
      const linkRows = links.map((l, idx) => ({
        ...l,
        app_id: req.params.id,
        sort_order: idx,
      }));
      const { error: linkErr } = await supabase.from("app_links").insert(linkRows);
      if (linkErr) return res.status(500).json({ error: linkErr.message });
    }
  }

  res.json(data);
});

// Delete app
app.delete("/api/admin/apps/:id", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("apps").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// =========================================================
// TELEGRAM BOT AUTO-REPLY (Robust Polling)
// =========================================================
// Old pollTelegram removed to prevent MTKruto conflicts.


// =========================================================
// REPORTS ROUTES
// =========================================================

// Submit a report
app.post("/api/reports", async (req, res) => {
  const { app_id, reason, comments } = req.body;
  if (!app_id || !reason) {
    return res.status(400).send("App ID and Reason are required");
  }
  
  const { data, error } = await supabase
    .from("app_reports")
    .insert([{ app_id, reason, comments }]);
    
  if (error) {
    console.error("Error submitting report:", error);
    return res.status(500).send(error.message);
  }
  res.json({ success: true });
});

// Fetch all reports (for Admin)
app.get("/api/reports", async (req, res) => {
  const { data, error } = await supabase
    .from("app_reports")
    .select(`
      id,
      reason,
      comments,
      created_at,
      apps ( name, icon_url )
    `)
    .order("created_at", { ascending: false });
    
  if (error) {
    return res.status(500).send(error.message);
  }
  res.json(data);
});

// Delete a report
app.delete("/api/reports/:id", async (req, res) => {
  const { error } = await supabase
    .from("app_reports")
    .delete()
    .eq("id", req.params.id);
    
  if (error) {
    return res.status(500).send(error.message);
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

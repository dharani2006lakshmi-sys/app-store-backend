import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (curl, mobile apps) and allowed origins
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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
      .select("id, name, description, icon_url, version, category_id, sort_order")
      .eq("is_published", true)
      .order("sort_order", { ascending: true });

    if (appErr) throw appErr;

    const { data: links, error: linkErr } = await supabase
      .from("app_links")
      .select("id, app_id, label, file_name, sort_order")
      .order("sort_order", { ascending: true });

    if (linkErr) throw linkErr;

    // attach links to their app
    const appsWithLinks = apps.map((a) => ({
      ...a,
      links: links
        .filter((l) => l.app_id === a.id)
        .map((l) => ({ id: l.id, label: l.label, file_name: l.file_name })),
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
      .select("telegram_file_id, file_name")
      .eq("id", linkId)
      .single();

    if (error || !link) {
      return res.status(404).send("File not found");
    }

    // Step 1: ask Telegram for the file path
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${link.telegram_file_id}`
    );
    const fileInfo = await fileInfoRes.json();

    if (!fileInfo.ok) {
      return res.status(502).send("Failed to resolve file from Telegram");
    }

    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    // Step 2: stream the file to the user, our domain only
    const fileRes = await fetch(fileUrl);

    if (!fileRes.ok) {
      return res.status(502).send("Failed to download file from Telegram");
    }

    const fileName = link.file_name || "app.apk";
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader(
      "Content-Type",
      fileRes.headers.get("content-type") || "application/vnd.android.package-archive"
    );
    const contentLength = fileRes.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    fileRes.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// =========================================================
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

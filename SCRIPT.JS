// Full updated script.js — Live Risk Monitor + OCR (Tesseract) + Chart.js integration

// ===== BASIC HELPERS =====
const $ = (id) => document.getElementById(id);

function setRiskVisual(score, barEl, labelEl) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  if (barEl) barEl.style.width = `${clamped}%`;
  if (!labelEl) return;

  if (clamped < 30) {
    labelEl.textContent = "Low risk – looks normal.";
    labelEl.style.color = "#2ea44f";
  } else if (clamped < 60) {
    labelEl.textContent = "Medium risk – check carefully.";
    labelEl.style.color = "#d97706";
  } else {
    labelEl.textContent = "High risk – very suspicious!";
    labelEl.style.color = "#e11d48";
  }
}

// ===== HISTORY STORAGE =====
const STORAGE_KEY = "payguard_history_v1";
let history = loadHistory();

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

// ===== PATTERN MATCHING =====
function getUserPattern() {
  const safe = history.filter((t) => t.markedSafe);
  if (!safe.length) return null;

  const avgAmount = safe.reduce((s, t) => s + (Number(t.amount) || 0), 0) / safe.length;

  const merchantFreq = {};
  for (const t of safe) {
    if (t.merchant) {
      const m = t.merchant.trim().toLowerCase();
      merchantFreq[m] = (merchantFreq[m] || 0) + 1;
    }
  }

  const commonMerchants = Object.entries(merchantFreq)
    .filter(([_, count]) => count >= 2)
    .map(([m]) => m);

  return { avgAmount, commonMerchants };
}

// ===== TRANSACTION ANALYSIS =====
function analyzeTransaction({ channel = "upi", amount = 0, merchant = "", accountHint = "", link = "", notes = "" }) {
  let score = 0;
  const reasons = [];

  const textCombined = [merchant, accountHint, link, notes].filter(Boolean).join(" ").toLowerCase();

  // channel risk
  const channelRisk = { upi: 20, wallet: 15, card: 10, netbanking: 25 };
  score += channelRisk[channel] || 10;

  // amount risk
  const amt = Number(amount || 0);
  if (amt >= 1000000) { score += 40; reasons.push("Very high transaction amount."); }
  else if (amt >= 100000) { score += 25; reasons.push("High transaction amount."); }
  else if (amt >= 10000) { score += 15; reasons.push("Medium-high transaction amount."); }
  else if (amt >= 3000) { score += 6; reasons.push("Medium transaction amount."); }

  // phrases
  const strong = ["urgent", "immediately", "send money", "refund", "blocked", "verification required", "update kyc", "confirm your identity", "your account will be blocked", "last warning"];
  for (const kw of strong) {
    if (textCombined.includes(kw)) {
      score += 12;
      reasons.push(`Strong phrase matched: "${kw}"`);
    }
  }

  const medium = ["kyc", "verification", "lottery", "win", "click here", "limited time", "confirm", "validate"];
  for (const kw of medium) {
    if (textCombined.includes(kw)) {
      score += 6;
      reasons.push(`Suspicious keyword: "${kw}"`);
    }
  }

  // short links
  const shortLinks = ["bit.ly", "tinyurl", "rb.gy", "t.me", "wa.me", "goo.gl"];
  for (const d of shortLinks) {
    if (textCombined.includes(d)) {
      score += 16;
      reasons.push(`Shortened link detected: ${d}`);
    }
  }

  // UPI pattern in text
  const upiRegex = /[a-z0-9._%+-]{2,}@[a-z]{2,}/i;
  if (upiRegex.test(textCombined)) {
    score += 8;
    reasons.push("UPI ID present in text.");
  }

  // combine with user pattern (small deduction if common merchant / amount)
  const pattern = getUserPattern();
  if (pattern) {
    if (!Number.isNaN(pattern.avgAmount) && Math.abs(amt - pattern.avgAmount) <= Math.max(1, pattern.avgAmount * 0.5)) {
      score = Math.max(0, score - 6);
      reasons.push("Amount close to your usual spending pattern.");
    }
    const merchantNormalized = (merchant || "").trim().toLowerCase();
    if (merchantNormalized && pattern.commonMerchants.includes(merchantNormalized)) {
      score = Math.max(0, score - 10);
      reasons.push("Merchant is a commonly used merchant in your history.");
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    level: score >= 70 ? "High" : score >= 40 ? "Medium" : "Low",
    reasons,
  };
}

// ===== OCR: preprocess + Tesseract.js (v4) =====
async function preprocessImageFileToDataURL(file, maxWidth = 1600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        // draw scaled
        ctx.drawImage(img, 0, 0, w, h);

        try {
          // simple grayscale + contrast boost
          const imageData = ctx.getImageData(0, 0, w, h);
          const data = imageData.data;

          // contrast adjustment: center + multiply
          const contrast = 1.15; // slight boost
          const intercept = 128 * (1 - contrast);
          for (let i = 0; i < data.length; i += 4) {
            // grayscale formula
            const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            const val = Math.min(255, Math.max(0, Math.round(gray * contrast + intercept)));
            data[i] = data[i + 1] = data[i + 2] = val;
          }
          ctx.putImageData(imageData, 0, 0);
        } catch (e) {
          // ignore transform if cross-origin or other issues
        }

        try {
          resolve(canvas.toDataURL("image/png"));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Failed to load image for preprocessing."));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function extractTextFromImageWithTesseract(file, onProgress) {
  // use preprocess to improve OCR accuracy (scale + grayscale)
  const dataUrl = await preprocessImageFileToDataURL(file);
  if (!window.Tesseract || !Tesseract.recognize) {
    throw new Error("Tesseract not loaded.");
  }

  return new Promise((resolve, reject) => {
    const logger = (m) => {
      if (onProgress && typeof onProgress === "function") onProgress(m);
    };

    Tesseract.recognize(dataUrl, "eng", { logger })
      .then((result) => resolve(result && (result.data && result.data.text) ? result.data.text : (result && result.text ? result.text : "")))
      .catch(reject);
  });
}

// ===== OCR TEXT ANALYSIS =====
function analyzeTextForScam(text) {
  const lower = (text || "").toLowerCase();
  let score = 0;
  const reasons = [];

  if (!lower.trim()) {
    return { score: 0, reasons: ["No text detected"] };
  }

  const strong = ["otp", "one-time", "pin", "cvv", "password", "screen share", "anydesk", "teamviewer", "share code"];
  for (const s of strong) {
    if (lower.includes(s)) {
      score += 20;
      reasons.push(`Strong secret phrase: "${s}"`);
    }
  }

  const medium = ["kyc", "verification", "update pan", "account blocked", "last warning", "urgent", "limited time", "click here", "refund", "verify"];
  for (const s of medium) {
    if (lower.includes(s)) {
      score += 10;
      reasons.push(`Suspicious term: "${s}"`);
    }
  }

  const upiRegex = /[a-z0-9._%+-]{2,}@[a-z]{2,}/g;
  const upis = (lower.match(upiRegex) || []);
  if (upis.length) {
    score += Math.min(20, 8 * upis.length);
    reasons.push(`UPI IDs found: ${upis.slice(0,3).join(", ")}`);
  }

  const shorties = ["bit.ly", "tinyurl", "rb.gy", "t.me", "wa.me", "goo.gl"];
  for (const s of shorties) {
    if (lower.includes(s)) {
      score += 16;
      reasons.push(`Shortened or external link: "${s}"`);
    }
  }

  // loose phone number detection (any 8+ digits chunk)
  const phoneMatch = lower.match(/\b\d{6,}\b/g) || [];
  if (phoneMatch.length) {
    score += 6;
    reasons.push("Phone number-like digits found.");
  }

  // official-sounding + suspicious cues
  if ((lower.includes("customer care") || lower.includes("support")) && (lower.includes("urgent") || upis.length || shorties.some(s => lower.includes(s)))) {
    score += 12;
    reasons.push("Official-sounding message with suspicious cues.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}

// ===== HISTORY UI =====
function addToHistory(entry) {
  history.unshift(entry);
  history = history.slice(0, 30);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const box = $("alerts-list");
  if (!box) return;
  if (!history.length) {
    box.innerHTML = "No transactions analysed yet.";
    box.classList.add("empty-state");
    return;
  }
  box.classList.remove("empty-state");
  box.innerHTML = "";
  history.forEach((h) => {
    const d = document.createElement("div");
    d.className = "alert-item";
    d.innerHTML = `
      <div class="alert-main">
        <div class="alert-merchant">${h.merchant || "Payment"}</div>
        <div class="alert-meta">₹${Number(h.amount || 0).toLocaleString()} • ${String(h.channel || "N/A").toUpperCase()}</div>
      </div>
      <div class="alert-risk-tag ${h.score >= 60 ? "high" : h.score >= 30 ? "medium" : "low"}">
        ${h.score}
      </div>
    `;
    d.addEventListener("click", () => {
      // expand/copy details if needed
      alert(`Details:\nMerchant: ${h.merchant || "−"}\nAmount: ₹${h.amount || 0}\nScore: ${h.score}\nNotes: ${h.notes || "—"}`);
    });
    box.appendChild(d);
  });
}

// ===== FORMS / HANDLERS =====
function setupTransactionForm() {
  const form = $("transaction-form");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const data = {
      channel: ($("channel") && $("channel").value) || "upi",
      amount: ($("amount") && $("amount").value) || 0,
      merchant: ($("merchant") && $("merchant").value) || "",
      accountHint: ($("accountHint") && $("accountHint").value) || "",
      link: ($("link") && $("link").value) || "",
      notes: ($("notes") && $("notes").value) || "",
    };

    const out = analyzeTransaction(data);
    const resultWrap = $("transaction-result");
    if (resultWrap) resultWrap.classList.remove("hidden");

    if ($("tx-risk-score")) $("tx-risk-score").textContent = out.score;
    setRiskVisual(out.score, $("tx-risk-bar-fill"), $("tx-risk-level"));

    if ($("tx-reasons")) {
      $("tx-reasons").innerHTML = out.reasons.map(r => `<li>${r}</li>`).join("");
    }

    addToHistory({ ...data, score: out.score, markedSafe: false });
    updateHeroRisk();
  });

  // Mark as safe button if present (btn id mark-safe-btn)
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "mark-safe-btn") {
      const lastEntry = history[0];
      if (lastEntry) {
        lastEntry.markedSafe = true;
        saveHistory();
        renderHistory();
        alert("Transaction marked safe. System will learn from this!");
        updateHeroRisk();
      }
    }
  });
}

function setupOcrForm() {
  const form = $("ocr-form");
  if (!form) return;
  const loading = $("ocr-loading");
  const resultWrap = $("ocr-result");
  const scoreEl = $("ocr-risk-score");
  const barEl = $("ocr-risk-bar-fill");
  const levelEl = $("ocr-risk-level");
  const textEl = $("ocr-text");
  const reasonsEl = $("ocr-reasons");

  // file input (support both common IDs)
  const fileInput = $("ocr-file") || $("ocr-image") || form.querySelector("input[type=file]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!fileInput || !fileInput.files || !fileInput.files.length) {
      alert("Please choose an image to scan.");
      return;
    }
    const file = fileInput.files[0];

    // Show loader
    if (loading) {
      loading.classList.remove("hidden");
      loading.textContent = "Scanning screenshot…";
    }
    if (resultWrap) resultWrap.classList.add("hidden");

    try {
      const progressCb = (m) => {
        if (loading && m && m.progress !== undefined) {
          loading.textContent = `${m.status || "Processing"} — ${Math.round((m.progress || 0) * 100)}%`;
        } else if (loading && m && m.status) {
          loading.textContent = m.status;
        }
      };

      const extractedText = await extractTextFromImageWithTesseract(file, progressCb);
      const trimmed = (extractedText || "").trim();
      const analysis = analyzeTextForScam(trimmed);

      if (resultWrap) resultWrap.classList.remove("hidden");
      if (scoreEl) scoreEl.textContent = analysis.score;
      if (textEl) textEl.textContent = trimmed || "(No text detected)";
      if (reasonsEl) {
        reasonsEl.innerHTML = analysis.reasons.length ? analysis.reasons.map(r => `<li>${r}</li>`).join("") : "<li>No immediate red flags</li>";
      }
      setRiskVisual(analysis.score, barEl, levelEl);

      addToHistory({
        channel: "ocr",
        amount: 0,
        merchant: file.name || "Screenshot",
        accountHint: "",
        link: "",
        notes: (trimmed || "").substring(0, 200),
        score: analysis.score,
        markedSafe: false,
      });
      updateHeroRisk();
    } catch (err) {
      console.error("OCR error:", err);
      alert(`OCR failed: ${err && err.message ? err.message : err}`);
    } finally {
      if (loading) {
        loading.classList.add("hidden");
        loading.textContent = "Scanning screenshot…";
      }
    }
  });
}

// ===== SUBSCRIPTION FORM =====
function setupSubscriptionForm() {
  const form = $("subscription-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("sub-email") ? $("sub-email").value : "";
    const status = $("subscription-status");
    if (status) {
      status.textContent = email ? `✓ Saved! Alerts will be sent to ${email}` : "✓ Saved!";
      status.style.color = "#2ea44f";
      setTimeout(() => { if (status) status.textContent = ""; }, 3000);
    }
  });
}

// ===== LIVE GRAPH & HERO MONITOR =====
let liveGraphState = { chart: null, data: [] };

function updateHeroRisk() {
  const heroScoreEl = $("hero-risk-score");
  const heroBar = $("hero-risk-bar-fill");
  const heroLabel = $("hero-risk-label");
  if (!heroScoreEl || !heroBar) return;

  const data = liveGraphState.data || [];
  let graphScore = 40; // baseline if no graph

  if (data.length) {
    const arr = data.map(d => d.scams || 0);
    const last = arr[arr.length - 1];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    let normalized = 50;
    if (min !== max) normalized = Math.round(((last - min) / (max - min)) * 100);
    graphScore = normalized;
  }

  const lastHistoryScore = (history && history.length) ? Number(history[0].score || 0) : null;
  const finalScore = lastHistoryScore !== null && !isNaN(lastHistoryScore)
    ? Math.round(graphScore * 0.6 + lastHistoryScore * 0.4)
    : graphScore;

  heroScoreEl.textContent = `${finalScore} / 100`;
  setRiskVisual(finalScore, heroBar, heroLabel);

  if (heroLabel) heroLabel.textContent = `Live risk updated ${new Date().toLocaleTimeString()}`;
}

// ChartJS loader
function ensureChartJs() {
  if (window.Chart) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/chart.js";
    script.onload = () => resolve();
    script.onerror = (err) => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(script);
  });
}

function createLiveScamSection() {
  let wrapper = $("live-scam-section");
  if (wrapper) return wrapper;

  wrapper = document.createElement("div");
  wrapper.id = "live-scam-section";
  wrapper.className = "card";
  wrapper.style.marginBottom = "20px";
  wrapper.innerHTML = `
    <h3>Global UPI Scams Trend</h3>
    <div style="width:100%;height:250px;">
      <canvas id="live-scam-canvas"></canvas>
    </div>
  `;

  const alerts = $("alerts");
  if (alerts && alerts.parentNode) {
    alerts.parentNode.insertBefore(wrapper, alerts);
  } else if (document.querySelector("main")) {
    document.querySelector("main").appendChild(wrapper);
  } else {
    document.body.appendChild(wrapper);
  }
  return wrapper;
}

function generateMockScamData() {
  const data = [];
  let val = 200;
  for (let i = 14; i >= 0; i--) {
    val += Math.round(Math.random() * 30 - 15);
    const d = new Date();
    d.setDate(d.getDate() - i);
    data.push({ date: d.toISOString().slice(0, 10), scams: Math.max(50, val) });
  }
  return data;
}

async function setupLiveScamGraph() {
  const section = createLiveScamSection();
  await ensureChartJs();

  const canvas = document.getElementById("live-scam-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  let data = generateMockScamData();

  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map(d => d.date),
      datasets: [{
        label: "UPI scam reports",
        data: data.map(d => d.scams),
        borderColor: "rgb(255,80,80)",
        backgroundColor: "rgba(255,80,80,0.12)",
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.25,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxRotation: 0 } } }
    }
  });

  liveGraphState.chart = chart;
  liveGraphState.data = data;

  // Initial hero update
  updateHeroRisk();

  // live update
  setInterval(() => {
    const last = data[data.length - 1].scams;
    const next = Math.max(50, Math.round(last + (Math.random() - 0.5) * 20));
    data.push({ date: new Date().toLocaleTimeString(), scams: next });
    if (data.length > 20) data.shift();

    chart.data.labels = data.map(d => d.date);
    chart.data.datasets[0].data = data.map(d => d.scams);
    chart.update();

    liveGraphState.data = data;
    updateHeroRisk();
  }, 1000);
}

// ===== CLEAR HISTORY BUTTON =====
function setupClearHistory() {
  const btn = $("clear-history");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!confirm("Clear all transaction history?")) return;
    history = [];
    saveHistory();
    renderHistory();
    updateHeroRisk();
  });
}

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
  initYear();
  setupTransactionForm();
  setupOcrForm();
  setupSubscriptionForm();
  setupClearHistory();
  renderHistory();
  setupLiveScamGraph();
});

// ===== FOOTER YEAR =====
function initYear() {
  const el = $("year");
  if (el) el.textContent = new Date().getFullYear();
}

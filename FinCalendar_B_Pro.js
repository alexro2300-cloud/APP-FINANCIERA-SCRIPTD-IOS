// FinCalendar_B_Pro — Calendario financiero personal (Scriptable)
// Mejoras incluidas:
// 1) Validaciones de negocio (saldo de fondo / disponible / montos)
// 2) Carga segura del JSON con respaldo automático
// 3) Upgrade de esquema no destructivo
// 4) Ajustes explícitos de fondos con bitácora
// 5) Resumen mensual y búsqueda rápida
// 6) Horarios de sync configurables por settings

const APP_FOLDER = "FinCalendar";
const DATA_FILE = "data.json";
const NATIVE_CAL_NAME = "FinCalendar";
const MAX_TEXT = 80;

const fm = FileManager.iCloud();
const baseDir = fm.joinPath(fm.documentsDirectory(), APP_FOLDER);
const dataPath = fm.joinPath(baseDir, DATA_FILE);

function todayISO() { return new Date().toISOString().slice(0, 10); }
function isoToDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(n => parseInt(n, 10));
  return new Date(y, m - 1, d);
}
function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + "$" + abs.toFixed(2);
}
function monthKey(d) {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}
function iso(d) { return d.toISOString().slice(0, 10); }
function clampText(s, fallback = "") {
  if (typeof s !== "string") return fallback;
  const cleaned = s.trim();
  return cleaned.slice(0, MAX_TEXT);
}
function toPositiveNumber(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  if (n <= 0) return null;
  return Math.abs(n);
}

function defaultData() {
  return {
    settings: {
      currency: "MXN",
      startBalance: 0,
      calendarTimes: {
        obligationHour: 8,
        transactionHour: 9,
        allocationHour: 10
      }
    },
    funds: [
      { id: "f_ahorro", name: "Ahorro", balance: 0 },
      { id: "f_tarjetas", name: "Tarjetas", balance: 0 },
      { id: "f_varios", name: "Gastos varios", balance: 0 }
    ],
    obligations: [],
    transactions: [],
    allocations: [],
    fundAdjustments: []
  };
}

function mergeDefaults(data) {
  const d = data || {};
  const base = defaultData();
  d.settings = d.settings || {};
  d.settings.currency = d.settings.currency || base.settings.currency;
  d.settings.startBalance = Number(d.settings.startBalance || 0);
  d.settings.calendarTimes = d.settings.calendarTimes || {};
  d.settings.calendarTimes.obligationHour = Number.isInteger(d.settings.calendarTimes.obligationHour)
    ? d.settings.calendarTimes.obligationHour : base.settings.calendarTimes.obligationHour;
  d.settings.calendarTimes.transactionHour = Number.isInteger(d.settings.calendarTimes.transactionHour)
    ? d.settings.calendarTimes.transactionHour : base.settings.calendarTimes.transactionHour;
  d.settings.calendarTimes.allocationHour = Number.isInteger(d.settings.calendarTimes.allocationHour)
    ? d.settings.calendarTimes.allocationHour : base.settings.calendarTimes.allocationHour;

  d.funds = Array.isArray(d.funds) ? d.funds : base.funds;
  d.obligations = Array.isArray(d.obligations) ? d.obligations : [];
  d.transactions = Array.isArray(d.transactions) ? d.transactions : [];
  d.allocations = Array.isArray(d.allocations) ? d.allocations : [];
  d.fundAdjustments = Array.isArray(d.fundAdjustments) ? d.fundAdjustments : [];
  return d;
}

async function ensureStorage() {
  if (!fm.fileExists(baseDir)) fm.createDirectory(baseDir, true);
  if (!fm.fileExists(dataPath)) {
    fm.writeString(dataPath, JSON.stringify(defaultData(), null, 2));
  }
  await fm.downloadFileFromiCloud(dataPath);
}

function safeLoadData() {
  try {
    const txt = fm.readString(dataPath);
    const parsed = JSON.parse(txt);
    const merged = mergeDefaults(parsed);
    return merged;
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[.:]/g, "-");
    const backup = fm.joinPath(baseDir, `data.corrupt.${stamp}.json`);
    if (fm.fileExists(dataPath)) {
      const raw = fm.readString(dataPath);
      fm.writeString(backup, raw);
    }
    const fresh = defaultData();
    saveData(fresh);
    return fresh;
  }
}
function saveData(data) { fm.writeString(dataPath, JSON.stringify(mergeDefaults(data), null, 2)); }
function uid(prefix) { return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`; }

async function showMsg(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("OK");
  await a.presentAlert();
}

async function confirm(title, message, okText = "Aceptar", cancelText = "Cancelar") {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction(okText);
  a.addCancelAction(cancelText);
  const r = await a.presentAlert();
  return r !== -1;
}

async function pickFromList(title, items, displayFn = (x)=>String(x), cancelText="Cancelar") {
  const a = new Alert();
  a.title = title;
  items.forEach(it => a.addAction(displayFn(it)));
  a.addCancelAction(cancelText);
  const idx = await a.presentSheet();
  if (idx === -1) return null;
  return items[idx];
}
async function askText(title, placeholder = "", defaultValue = "") {
  const a = new Alert();
  a.title = title;
  a.addTextField(placeholder, defaultValue);
  a.addAction("OK");
  a.addCancelAction("Cancelar");
  const r = await a.presentAlert();
  if (r === -1) return null;
  return clampText(a.textFieldValue(0), "");
}
async function askNumber(title, placeholder = "", defaultValue = "") {
  const t = await askText(title, placeholder, defaultValue);
  if (t === null) return null;
  const n = Number(t.replace(",", "."));
  if (!isFinite(n)) { await showMsg("Dato inválido", "Escribe un número válido."); return null; }
  return n;
}

function getDaysOfMonth(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();
  const first = new Date(y, m, 1);
  const next = new Date(y, m + 1, 1);
  const days = [];
  for (let d = new Date(first); d < next; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  return days;
}

async function pickDateInMonth(dateObj, title="Elige fecha") {
  const days = getDaysOfMonth(dateObj);
  return await pickFromList(title, days, d => iso(d));
}

function sumTransactionsForDate(data, isoDate) {
  let income = 0, expense = 0, allocationsOut = 0, allocationsIn = 0;

  for (const t of data.transactions) {
    if (t.date !== isoDate) continue;
    if (t.type === "income") income += t.amount;
    if (t.type === "expense") expense += t.amount;
  }
  for (const al of data.allocations) {
    if (al.date !== isoDate) continue;
    if (al.direction === "toFund" || al.direction === "toObligation") allocationsOut += al.amount;
    if (al.direction === "release") allocationsIn += al.amount;
  }
  return { income, expense, allocationsOut, allocationsIn };
}

function computeAvailableBalance(data, untilIso = null) {
  let balance = Number(data.settings.startBalance || 0);

  for (const t of data.transactions) {
    if (untilIso && t.date > untilIso) continue;
    if (t.type === "income") balance += Number(t.amount || 0);
    if (t.type === "expense") balance -= Number(t.amount || 0);
  }
  for (const al of data.allocations) {
    if (untilIso && al.date > untilIso) continue;
    if (al.direction === "toFund" || al.direction === "toObligation") balance -= Number(al.amount || 0);
    if (al.direction === "release") balance += Number(al.amount || 0);
  }
  return balance;
}

function getFundById(data, id) { return data.funds.find(f => f.id === id) || null; }
function getOblById(data, id) { return data.obligations.find(o => o.id === id) || null; }

function computeObligationCoverage(data, obligationId) {
  const o = getOblById(data, obligationId);
  if (!o) return { covered: 0, remaining: 0 };

  let covered = 0;
  for (const al of data.allocations) {
    if (al.direction !== "toObligation") continue;
    if (al.toObligationId !== obligationId) continue;
    covered += al.amount;
  }
  const remaining = Math.max(0, (o.amount || 0) - covered);
  return { covered, remaining };
}

function monthlyTotals(data, monthDate) {
  const mk = monthKey(monthDate);
  const totals = {
    income: 0,
    expense: 0,
    allocated: 0,
    obligationsTotal: 0,
    obligationsCovered: 0,
    obligationsPaid: 0
  };

  for (const t of data.transactions) {
    if (!t.date.startsWith(mk)) continue;
    if (t.type === "income") totals.income += t.amount;
    if (t.type === "expense") totals.expense += t.amount;
  }
  for (const a of data.allocations) {
    if (!a.date.startsWith(mk)) continue;
    if (a.direction === "toFund" || a.direction === "toObligation") totals.allocated += a.amount;
  }
  for (const o of data.obligations) {
    if (!o.dueDate.startsWith(mk)) continue;
    totals.obligationsTotal += o.amount;
    const cov = computeObligationCoverage(data, o.id);
    totals.obligationsCovered += Math.min(o.amount, cov.covered);
    if (o.status === "pagada") totals.obligationsPaid += o.amount;
  }
  return totals;
}

// -------------------- CRUD --------------------

async function addTransaction(data, kind, monthDate) {
  const d = await pickDateInMonth(monthDate, `Fecha del ${kind === "income" ? "ingreso" : "gasto"}`);
  if (!d) return;

  const name = await askText("Concepto", "Ej: Nómina / Pago / Gas", "");
  if (!name) return;

  const amountRaw = await askNumber("Monto", "Ej: 1500", "");
  if (amountRaw === null) return;

  const amount = toPositiveNumber(amountRaw);
  if (!amount) {
    await showMsg("Dato inválido", "El monto debe ser mayor a 0.");
    return;
  }

  data.transactions.push({
    id: uid("tx"),
    date: iso(d),
    type: kind,
    name,
    amount,
    category: (kind === "expense" ? "Importante" : "Ingreso"),
    note: ""
  });

  saveData(data);
  await showMsg("Listo", `${kind === "income" ? "Ingreso" : "Gasto"} agregado: ${name} ${fmtMoney(kind === "income" ? amount : -amount)}`);
}

async function addFund(data) {
  const name = await askText("Nombre del fondo", "Ej: Nu / Renta / Emergencias", "");
  if (!name) return;

  const exists = data.funds.some(f => f.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    await showMsg("Duplicado", "Ya existe un fondo con ese nombre.");
    return;
  }

  data.funds.push({ id: uid("f"), name, balance: 0 });
  saveData(data);
  await showMsg("Listo", `Fondo creado: ${name}`);
}

async function addObligation(data, monthDate) {
  const d = await pickDateInMonth(monthDate, "Fecha de pago (obligación)");
  if (!d) return;

  const name = await askText("Nombre", "Ej: Nu / Colegiatura / Deuda", "");
  if (!name) return;

  const amountRaw = await askNumber("Monto a pagar", "Ej: 200", "");
  if (amountRaw === null) return;

  const amount = toPositiveNumber(amountRaw);
  if (!amount) {
    await showMsg("Dato inválido", "El monto debe ser mayor a 0.");
    return;
  }

  data.obligations.push({
    id: uid("obl"),
    name,
    dueDate: iso(d),
    amount,
    status: "pendiente", // pendiente | cubierta | pagada
    note: ""
  });

  saveData(data);
  await showMsg("Listo", `Obligación creada: ${name} (${fmtMoney(-amount)}) para ${iso(d)}`);
}

async function allocateMoney(data, monthDate) {
  const d = await pickDateInMonth(monthDate, "Fecha del apartado/asignación");
  if (!d) return;

  const amountRaw = await askNumber("¿Cuánto vas a apartar?", "Ej: 200", "");
  if (amountRaw === null) return;

  const amount = toPositiveNumber(amountRaw);
  if (!amount) {
    await showMsg("Dato inválido", "El monto debe ser mayor a 0.");
    return;
  }

  const available = computeAvailableBalance(data, iso(d));
  if (amount > available) {
    const ok = await confirm(
      "Apartado mayor al disponible",
      `Disponible estimado: ${fmtMoney(available)}\nIntentas apartar: ${fmtMoney(amount)}\n\n¿Deseas continuar de todos modos?`,
      "Continuar"
    );
    if (!ok) return;
  }

  const destType = await pickFromList("¿A dónde va?", ["Fondo", "Obligación"], x => x);
  if (!destType) return;

  if (destType === "Fondo") {
    const fund = await pickFromList("Elige fondo", data.funds, f => `${f.name} (saldo: ${fmtMoney(f.balance)})`);
    if (!fund) return;

    fund.balance += amount;
    data.allocations.push({
      id: uid("al"),
      date: iso(d),
      amount,
      direction: "toFund",
      toFundId: fund.id,
      note: ""
    });

    saveData(data);
    await showMsg("Listo", `Apartado a fondo: ${fund.name} +${fmtMoney(amount)}`);
    return;
  }

  const mk = monthKey(monthDate);
  const monthObls = data.obligations
    .filter(o => o.dueDate.startsWith(mk))
    .sort((a,b) => a.dueDate.localeCompare(b.dueDate));

  const obl = await pickFromList(
    "Elige obligación",
    monthObls.length ? monthObls : data.obligations,
    o => {
      const cov = computeObligationCoverage(data, o.id);
      const sem = (o.status === "pagada") ? "✅" : (cov.remaining <= 0 ? "🟢" : (cov.covered > 0 ? "🟡" : "🔴"));
      return `${sem} ${o.dueDate} — ${o.name} (${fmtMoney(-o.amount)}) cubierto: ${fmtMoney(cov.covered)}`;
    }
  );
  if (!obl) return;

  data.allocations.push({
    id: uid("al"),
    date: iso(d),
    amount,
    direction: "toObligation",
    toObligationId: obl.id,
    note: ""
  });

  const cov = computeObligationCoverage(data, obl.id);
  if (obl.status !== "pagada") obl.status = (cov.remaining <= 0) ? "cubierta" : "pendiente";

  saveData(data);
  await showMsg("Listo", `Asignado a obligación: ${obl.name} +${fmtMoney(amount)}`);
}

async function registerPayment(data, monthDate) {
  const mk = monthKey(monthDate);
  const obls = data.obligations
    .filter(o => o.dueDate.startsWith(mk))
    .sort((a,b) => a.dueDate.localeCompare(b.dueDate));

  const obl = await pickFromList("¿Qué obligación pagaste?", obls.length ? obls : data.obligations,
    o => {
      const cov = computeObligationCoverage(data, o.id);
      return `${o.dueDate} — ${o.name} (${o.status}) ${fmtMoney(-o.amount)} | cubierto: ${fmtMoney(cov.covered)}`;
    }
  );
  if (!obl) return;

  const cov = computeObligationCoverage(data, obl.id);
  const amountRaw = await askNumber("Monto pagado", "Pago total o parcial", String(cov.remaining > 0 ? cov.remaining : obl.amount));
  if (amountRaw === null) return;

  const paidAmount = toPositiveNumber(amountRaw);
  if (!paidAmount) {
    await showMsg("Dato inválido", "El monto pagado debe ser mayor a 0.");
    return;
  }

  const useFund = await pickFromList("¿Descontar de un fondo?", ["Sí", "No"], x => x);
  if (!useFund) return;

  if (useFund === "Sí") {
    const fund = await pickFromList("Elige fondo", data.funds, f => `${f.name} (saldo: ${fmtMoney(f.balance)})`);
    if (!fund) return;
    if (fund.balance < paidAmount) {
      await showMsg("Saldo insuficiente", `El fondo ${fund.name} no tiene saldo suficiente.`);
      return;
    }
    fund.balance -= paidAmount;
  }

  data.transactions.push({
    id: uid("tx"),
    date: todayISO(),
    type: "expense",
    name: `Pago: ${obl.name}`,
    amount: paidAmount,
    category: "Pago",
    note: ""
  });

  if (paidAmount >= obl.amount) obl.status = "pagada";
  else obl.status = cov.remaining - paidAmount <= 0 ? "pagada" : "pendiente";

  saveData(data);
  await showMsg("Listo", `Pago registrado: ${obl.name} (${fmtMoney(-paidAmount)})`);
}

async function adjustFundBalance(data) {
  const fund = await pickFromList("Elige fondo", data.funds, f => `${f.name} (saldo: ${fmtMoney(f.balance)})`);
  if (!fund) return;

  const deltaRaw = await askNumber("Ajuste de saldo", "Usa + o - (ej: -50 / 120)", "0");
  if (deltaRaw === null) return;
  if (!isFinite(deltaRaw) || deltaRaw === 0) {
    await showMsg("Dato inválido", "El ajuste no puede ser 0.");
    return;
  }

  if (fund.balance + deltaRaw < 0) {
    await showMsg("No permitido", "El ajuste dejaría el fondo en negativo.");
    return;
  }

  const reason = await askText("Motivo del ajuste", "Ej: corrección manual", "");
  if (!reason) return;

  fund.balance += deltaRaw;
  data.fundAdjustments.push({
    id: uid("fadj"),
    date: todayISO(),
    fundId: fund.id,
    amount: deltaRaw,
    reason
  });

  saveData(data);
  await showMsg("Listo", `Ajuste aplicado: ${fund.name} ${fmtMoney(deltaRaw)} → ${fmtMoney(fund.balance)}`);
}

async function manageFunds(data) {
  const choice = await pickFromList("Fondos", ["Ver fondos", "Crear fondo", "Ajuste explícito de saldo"], x => x);
  if (!choice) return;

  if (choice === "Ver fondos") {
    const msg = data.funds.map(f => `• ${f.name}: ${fmtMoney(f.balance)}`).join("\n");
    await showMsg("Fondos", msg || "(vacío)");
    return;
  }
  if (choice === "Crear fondo") return await addFund(data);
  return await adjustFundBalance(data);
}

async function manageObligations(data, monthDate) {
  const choice = await pickFromList("Obligaciones", ["Ver obligaciones", "Crear obligación", "Cambiar estado"], x => x);
  if (!choice) return;

  const mk = monthKey(monthDate);

  if (choice === "Ver obligaciones") {
    const obls = data.obligations
      .filter(o => o.dueDate.startsWith(mk))
      .sort((a,b) => a.dueDate.localeCompare(b.dueDate));

    const msg = obls.length ? obls.map(o => {
      const cov = computeObligationCoverage(data, o.id);
      const sem = (o.status === "pagada") ? "✅" : (cov.remaining <= 0 ? "🟢" : (cov.covered > 0 ? "🟡" : "🔴"));
      return `${sem} ${o.dueDate} — ${o.name} ${fmtMoney(-o.amount)} | cubierto: ${fmtMoney(cov.covered)} | estado: ${o.status}`;
    }).join("\n") : "(sin obligaciones este mes)";

    await showMsg(`Obligaciones ${mk}`, msg);
    return;
  }

  if (choice === "Crear obligación") return await addObligation(data, monthDate);

  const obl = await pickFromList("Elige obligación", data.obligations, o => `${o.dueDate} — ${o.name} (${o.status})`);
  if (!obl) return;
  const st = await pickFromList("Nuevo estado", ["pendiente", "cubierta", "pagada"], x => x);
  if (!st) return;
  obl.status = st;
  saveData(data);
  await showMsg("Listo", `Estado actualizado: ${obl.name} → ${st}`);
}

async function showMonthSummary(data, monthDate) {
  const mk = monthKey(monthDate);
  const t = monthlyTotals(data, monthDate);
  const net = t.income - t.expense;
  const savingsRate = t.income > 0 ? ((net / t.income) * 100) : 0;
  const coverageRate = t.obligationsTotal > 0 ? ((t.obligationsCovered / t.obligationsTotal) * 100) : 0;
  const paidRate = t.obligationsTotal > 0 ? ((t.obligationsPaid / t.obligationsTotal) * 100) : 0;

  await showMsg(
    `Resumen ${mk}`,
    [
      `Ingresos: ${fmtMoney(t.income)}`,
      `Gastos: ${fmtMoney(-t.expense)}`,
      `Neto: ${fmtMoney(net)}`,
      `Apartado: ${fmtMoney(-t.allocated)}`,
      `Cobertura obligaciones: ${coverageRate.toFixed(1)}%`,
      `Pagadas: ${paidRate.toFixed(1)}%`,
      `Tasa ahorro aprox: ${savingsRate.toFixed(1)}%`
    ].join("\n")
  );
}

async function quickSearch(data) {
  const q = await askText("Buscar", "Concepto, categoría, nota", "");
  if (!q) return;
  const needle = q.toLowerCase();

  const tx = data.transactions.filter(t =>
    (t.name || "").toLowerCase().includes(needle) ||
    (t.category || "").toLowerCase().includes(needle) ||
    (t.note || "").toLowerCase().includes(needle)
  );

  const obls = data.obligations.filter(o =>
    (o.name || "").toLowerCase().includes(needle) ||
    (o.note || "").toLowerCase().includes(needle)
  );

  const lines = [];
  lines.push(`Coincidencias transacciones: ${tx.length}`);
  tx.slice(0, 15).forEach(t => lines.push(`• ${t.date} ${t.name} ${fmtMoney(t.type === "income" ? t.amount : -t.amount)}`));
  lines.push("");
  lines.push(`Coincidencias obligaciones: ${obls.length}`);
  obls.slice(0, 15).forEach(o => lines.push(`• ${o.dueDate} ${o.name} ${fmtMoney(-o.amount)} (${o.status})`));

  await showMsg("Búsqueda", lines.join("\n") || "(sin coincidencias)");
}

// -------------------- Vista Texto --------------------

async function viewMonthText(data, monthDate) {
  const days = getDaysOfMonth(monthDate);
  const mk = monthKey(monthDate);

  const lines = [];
  lines.push(`📅 Mes: ${mk}`);
  lines.push("");

  let running = Number(data.settings.startBalance || 0);

  for (const day of days) {
    const dIso = iso(day);
    const sums = sumTransactionsForDate(data, dIso);

    const net = sums.income - sums.expense;
    const committedDelta = -sums.allocationsOut + sums.allocationsIn;

    running += net + committedDelta;

    const isToday = dIso === todayISO();
    const hasActivity = (sums.income || sums.expense || sums.allocationsOut || sums.allocationsIn);

    if (!hasActivity && !isToday) continue;

    const parts = [];
    if (sums.income) parts.push(`+${fmtMoney(sums.income)}`);
    if (sums.expense) parts.push(`${fmtMoney(-sums.expense)}`);
    if (sums.allocationsOut) parts.push(`Apartado: -${fmtMoney(sums.allocationsOut)}`);
    if (sums.allocationsIn) parts.push(`Liberado: +${fmtMoney(sums.allocationsIn)}`);

    const tag = isToday ? "⭐ " : "";
    lines.push(`${tag}${dIso}: ${parts.join(" | ")}  → Disponible: ${fmtMoney(running)}`);
  }

  lines.push("");
  lines.push("🧾 Obligaciones del mes:");
  const obls = data.obligations
    .filter(o => o.dueDate.startsWith(mk))
    .sort((a,b) => a.dueDate.localeCompare(b.dueDate));

  if (!obls.length) {
    lines.push("— (sin obligaciones)");
  } else {
    for (const o of obls) {
      const cov = computeObligationCoverage(data, o.id);
      let sem = "🔴";
      if (o.status === "pagada") sem = "✅";
      else if (cov.remaining <= 0) sem = "🟢";
      else if (cov.covered > 0) sem = "🟡";
      lines.push(`${sem} ${o.dueDate} — ${o.name} ${fmtMoney(-o.amount)} | cubierto: ${fmtMoney(cov.covered)} | faltante: ${fmtMoney(cov.remaining)}`);
    }
  }

  lines.push("");
  lines.push("💰 Fondos:");
  for (const f of data.funds) lines.push(`• ${f.name}: ${fmtMoney(f.balance)}`);

  const a = new Alert();
  a.title = `Calendario ${mk}`;
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.presentAlert();
}

// -------------------- Vista GUI tipo Calendario --------------------

async function viewCalendarGUI(data, monthDate) {
  const mk = monthKey(monthDate);
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  const byDay = {};
  for (let d = 1; d <= daysInMonth; d++) {
    byDay[String(d).padStart(2,"0")] = { income:0, expense:0, obligations:0, allocations:0, paid:0 };
  }

  for (const t of data.transactions) {
    if (!t.date.startsWith(mk)) continue;
    const dd = t.date.slice(8,10);
    if (!byDay[dd]) continue;
    if (t.type === "income") byDay[dd].income += t.amount;
    if (t.type === "expense") byDay[dd].expense += t.amount;
  }
  for (const a of data.allocations) {
    if (!a.date.startsWith(mk)) continue;
    const dd = a.date.slice(8,10);
    if (!byDay[dd]) continue;
    if (a.direction === "toFund" || a.direction === "toObligation") byDay[dd].allocations += a.amount;
  }
  for (const o of data.obligations) {
    if (!o.dueDate.startsWith(mk)) continue;
    const dd = o.dueDate.slice(8,10);
    if (!byDay[dd]) continue;
    byDay[dd].obligations += 1;
    if (o.status === "pagada") byDay[dd].paid += 1;
  }

  const weekday = ["L","M","M","J","V","S","D"];
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(`<div class="cell empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dd = String(d).padStart(2,"0");
    const e = byDay[dd];
    const dots = [];
    if (e.income > 0) dots.push(`<span class="dot">💰</span>`);
    if (e.expense > 0) dots.push(`<span class="dot">💸</span>`);
    if (e.allocations > 0) dots.push(`<span class="dot">🧷</span>`);
    if (e.obligations > 0) dots.push(`<span class="dot">🧾</span>`);
    if (e.paid > 0) dots.push(`<span class="dot">✅</span>`);

    const badge = dots.length ? `<div class="dots">${dots.join("")}</div>` : `<div class="dots muted">—</div>`;
    const isToday = `${mk}-${dd}` === todayISO();

    cells.push(`
      <button class="cell ${isToday ? "today":""}" onclick="showDay('${mk}-${dd}')">
        <div class="num">${d}</div>
        ${badge}
      </button>
    `);
  }

  const details = {};
  const days = getDaysOfMonth(monthDate);
  for (const day of days) {
    const dIso = iso(day);
    const sums = sumTransactionsForDate(data, dIso);
    const lines = [];
    if (sums.income) lines.push(`💰 Ingresos: ${fmtMoney(sums.income)}`);
    if (sums.expense) lines.push(`💸 Gastos: ${fmtMoney(-sums.expense)}`);
    if (sums.allocationsOut) lines.push(`🧷 Apartados: ${fmtMoney(-sums.allocationsOut)}`);

    const obls = data.obligations.filter(o => o.dueDate === dIso);
    if (obls.length) {
      for (const o of obls) {
        const cov = computeObligationCoverage(data, o.id);
        const sem = (o.status === "pagada") ? "✅" : (cov.remaining <= 0 ? "🟢" : (cov.covered>0 ? "🟡" : "🔴"));
        lines.push(`🧾 ${sem} ${o.name}: ${fmtMoney(-o.amount)}`);
      }
    }
    details[dIso] = lines.length ? lines : ["(sin movimientos)"];
  }

  const html = `
  <html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body{font-family:-apple-system; margin:16px; background:#0b0b0c; color:#fff;}
      .top{display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;}
      .title{font-size:20px; font-weight:800;}
      .grid{display:grid; grid-template-columns:repeat(7,1fr); gap:8px;}
      .wd{opacity:.85; text-align:center; font-weight:700;}
      .cell{background:#1c1c1e; border:1px solid #2c2c2e; border-radius:12px; padding:10px; text-align:left; color:#fff;}
      .cell.today{border-color:#ffd60a;}
      .cell.empty{background:transparent; border:none;}
      button.cell{width:100%; cursor:pointer;}
      .num{font-size:16px; font-weight:900; margin-bottom:6px;}
      .dots{display:flex; gap:6px; flex-wrap:wrap;}
      .dots.muted{opacity:.35}
      .panel{margin-top:14px; background:#1c1c1e; border:1px solid #2c2c2e; border-radius:14px; padding:12px;}
      .panel h3{margin:0 0 8px 0; font-size:16px;}
      .line{opacity:.92; margin:4px 0;}
      .hint{opacity:.7; font-size:12px; margin-top:6px;}
    </style>
  </head>
  <body>
    <div class="top"><div class="title">Calendario ${mk}</div></div>

    <div class="grid" style="margin-bottom:8px;">
      ${weekday.map(w=>`<div class="wd">${w}</div>`).join("")}
    </div>

    <div class="grid">${cells.join("")}</div>

    <div class="panel" id="panel">
      <h3 id="panelTitle">Toca un día</h3>
      <div id="panelBody"></div>
      <div class="hint">Iconos: 💰 ingreso · 💸 gasto · 🧷 apartado · 🧾 obligación · ✅ pagado</div>
    </div>

    <script>
      const details = ${JSON.stringify(details)};
      function showDay(d){
        document.getElementById('panelTitle').innerText = d;
        const lines = details[d] || ["(sin datos)"];
        document.getElementById('panelBody').innerHTML = lines.map(x=>'<div class="line">'+x+'</div>').join('');
      }
    </script>
  </body></html>
  `;

  const wv = new WebView();
  await wv.loadHTML(html);
  await wv.present(true);
}

// -------------------- Calendario Nativo iPhone (Sync) --------------------

async function pickNativeCalendar() {
  const cals = await Calendar.forEvents();
  if (!cals || !cals.length) {
    await showMsg("Sin calendarios", "No encontré calendarios disponibles. Revisa permisos de Calendario en iOS.");
    return null;
  }

  const named = cals.find(c => c.title === NATIVE_CAL_NAME);
  if (named) return named;

  const a = new Alert();
  a.title = `"${NATIVE_CAL_NAME}" no existe`;
  a.message =
    `Scriptable no puede crear calendarios.\n\n` +
    `Crea uno en la app Calendario con nombre "${NATIVE_CAL_NAME}" (recomendado), ` +
    `o elige un calendario existente para usarlo.\n\n` +
    `Tip: puedes crear "FinCalendar" en Calendario > Calendarios > Agregar calendario.`;
  a.addAction("Elegir un calendario existente");
  a.addCancelAction("Cancelar");
  const r = await a.presentAlert();
  if (r === -1) return null;

  const cal = await pickFromList("Elige calendario destino", cals, c => c.title);
  return cal || null;
}

function monthRange(monthDate) {
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const start = new Date(y, m, 1, 0, 0, 0);
  const end = new Date(y, m + 1, 1, 0, 0, 0);
  return { start, end };
}

function buildEventWindow(date, hour) {
  const h = Math.max(0, Math.min(23, Number(hour || 9)));
  return {
    startDate: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, 0, 0),
    endDate: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, 20, 0)
  };
}

async function syncMonthToNativeCalendar(data, monthDate) {
  const cal = await pickNativeCalendar();
  if (!cal) return;

  const mk = monthKey(monthDate);
  const { start, end } = monthRange(monthDate);
  const times = data.settings.calendarTimes || {};

  const existing = await CalendarEvent.between(start, end, [cal]);
  for (const ev of existing) {
    if ((ev.notes || "").includes("FC:")) {
      await ev.remove();
    }
  }

  for (const t of data.transactions) {
    if (!t.date.startsWith(mk)) continue;

    const date = isoToDate(t.date);
    const ev = new CalendarEvent();
    ev.calendar = cal;
    const win = buildEventWindow(date, times.transactionHour);
    ev.startDate = win.startDate;
    ev.endDate = win.endDate;

    const amt = (t.type === "income") ? t.amount : -t.amount;
    const icon = (t.type === "income") ? "💰" : "💸";
    ev.title = `${icon} ${t.name} (${fmtMoney(amt)})`;
    ev.notes = `FC:TX:${t.id}\nTipo:${t.type}\nMonto:${t.amount}\nFecha:${t.date}`;
    await ev.save();
  }

  for (const a of data.allocations) {
    if (!a.date.startsWith(mk)) continue;

    const date = isoToDate(a.date);
    const ev = new CalendarEvent();
    ev.calendar = cal;
    const win = buildEventWindow(date, times.allocationHour);
    ev.startDate = win.startDate;
    ev.endDate = win.endDate;

    let label = "";
    if (a.direction === "toFund") {
      const f = getFundById(data, a.toFundId);
      label = `Fondo: ${f ? f.name : "?"}`;
    } else if (a.direction === "toObligation") {
      const o = getOblById(data, a.toObligationId);
      label = `Obligación: ${o ? o.name : "?"}`;
    } else {
      label = "Asignación";
    }

    ev.title = `🧷 Apartado ${label} (${fmtMoney(-a.amount)})`;
    ev.notes = `FC:AL:${a.id}\nMonto:${a.amount}\nFecha:${a.date}\n${label}`;
    await ev.save();
  }

  for (const o of data.obligations) {
    if (!o.dueDate.startsWith(mk)) continue;

    const date = isoToDate(o.dueDate);
    const ev = new CalendarEvent();
    ev.calendar = cal;
    const win = buildEventWindow(date, times.obligationHour);
    ev.startDate = win.startDate;
    ev.endDate = win.endDate;

    const cov = computeObligationCoverage(data, o.id);
    const sem = (o.status === "pagada") ? "✅" : (cov.remaining <= 0 ? "🟢" : (cov.covered > 0 ? "🟡" : "🔴"));
    const icon = (o.status === "pagada") ? "✅" : "🧾";

    ev.title = `${icon} ${o.name} (${fmtMoney(-o.amount)}) ${sem}`;
    ev.notes = `FC:OBL:${o.id}\nEstado:${o.status}\nCubierto:${cov.covered}\nFaltante:${cov.remaining}\nFecha:${o.dueDate}`;
    await ev.save();
  }

  await showMsg("Sync listo", `Sincronizado ${mk} al calendario: "${cal.title}".`);
}

// -------------------- MAIN --------------------

async function main() {
  await ensureStorage();
  let currentMonth = new Date();

  while (true) {
    const mk = monthKey(currentMonth);
    const menu = new Alert();
    menu.title = `FinCalendar (Modo B Pro) — ${mk}`;
    menu.message = "Elige una acción:";
    menu.addAction("📅 Ver calendario del mes (texto)");
    menu.addAction("🗓️ Ver calendario del mes (GUI)");
    menu.addAction("📊 Resumen del mes");
    menu.addAction("🔎 Búsqueda rápida");
    menu.addAction("➕ Agregar ingreso");
    menu.addAction("➖ Agregar gasto");
    menu.addAction("🧾 Obligaciones (tarjetas/deudas/pagos)");
    menu.addAction("💰 Fondos (sobres)");
    menu.addAction("🧷 Apartar / Asignar dinero");
    menu.addAction("✅ Registrar pago de obligación");
    menu.addAction("📲 Sync mes al Calendario iPhone");
    menu.addAction("◀️ Mes anterior");
    menu.addAction("▶️ Mes siguiente");
    menu.addCancelAction("Salir");

    const r = await menu.presentSheet();
    if (r === -1) break;

    if (r === 0) await viewMonthText(safeLoadData(), currentMonth);
    if (r === 1) await viewCalendarGUI(safeLoadData(), currentMonth);
    if (r === 2) await showMonthSummary(safeLoadData(), currentMonth);
    if (r === 3) await quickSearch(safeLoadData());
    if (r === 4) { const d = safeLoadData(); await addTransaction(d, "income", currentMonth); }
    if (r === 5) { const d = safeLoadData(); await addTransaction(d, "expense", currentMonth); }
    if (r === 6) { const d = safeLoadData(); await manageObligations(d, currentMonth); }
    if (r === 7) { const d = safeLoadData(); await manageFunds(d); }
    if (r === 8) { const d = safeLoadData(); await allocateMoney(d, currentMonth); }
    if (r === 9) { const d = safeLoadData(); await registerPayment(d, currentMonth); }
    if (r === 10) { const d = safeLoadData(); await syncMonthToNativeCalendar(d, currentMonth); }
    if (r === 11) currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    if (r === 12) currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
  }
}

await main();

// Task G — B2B Freight Cost Calculator: unit conversion, USPS zone lookup,
// and rate-card pricing (bracket + perUnit, manual + USPS zone sources).
const taskG = require("../js/task_g");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}
function close(a, b, tol) {
  return Math.abs(a - b) <= (tol == null ? 1e-6 : tol);
}

// ---- Unit conversion ----
assert(close(taskG.convertWeight(1, "kg", "lb"), 2.2046226, 1e-5), `1kg -> lb, got ${taskG.convertWeight(1, "kg", "lb")}`);
assert(close(taskG.convertWeight(1, "lb", "kg"), 0.45359237, 1e-6), `1lb -> kg, got ${taskG.convertWeight(1, "lb", "kg")}`);
assert(close(taskG.convertWeight(1, "lb", "oz"), 16), `1lb -> oz, got ${taskG.convertWeight(1, "lb", "oz")}`);
assert(close(taskG.convertWeight(1, "kg", "oz"), 35.27396, 1e-4), `1kg -> oz, got ${taskG.convertWeight(1, "kg", "oz")}`);
assert(close(taskG.convertWeight(5, "kg", "kg"), 5), "same-unit passthrough");
assert(close(taskG.convertLength(1, "in", "cm"), 2.54), `1in -> cm, got ${taskG.convertLength(1, "in", "cm")}`);

// ---- Volumetric weight ----
const vol1 = taskG.volumetricWeight({ length: 50, width: 40, height: 30, dimUnit: "cm", divisor: 5000 });
assert(vol1.unit === "kg" && close(vol1.value, 12), `50x40x30cm /5000 = 12kg, got ${JSON.stringify(vol1)}`);
const vol2 = taskG.volumetricWeight({ length: 20, width: 16, height: 12, dimUnit: "in", divisor: 139 });
assert(vol2.unit === "lb" && close(vol2.value, 3840 / 139), `dims/139, got ${JSON.stringify(vol2)}`);
const volNoDivisor = taskG.volumetricWeight({ length: 10, width: 10, height: 10, dimUnit: "cm", divisor: null });
assert(volNoDivisor.value === 0, "no divisor -> 0 volumetric weight");

// ---- USPS zone lookup (spot-checked against postcalc.usps.com/domesticzonechart) ----
// From Atlanta (303): a nearby Atlanta ZIP is local (zone 1), a West Coast
// ZIP is zone 8, and a Chicago-area ZIP (606xx) is zone 4.
assert(taskG.lookupUspsZone("303", "30301").zone === "1", `ATL->30301 local, got ${JSON.stringify(taskG.lookupUspsZone("303", "30301"))}`);
assert(taskG.lookupUspsZone("303", "90210").zone === "8", `ATL->90210 (Beverly Hills), got ${JSON.stringify(taskG.lookupUspsZone("303", "90210"))}`);
assert(taskG.lookupUspsZone("303", "60601").zone === "4", `ATL->60601 (Chicago), got ${JSON.stringify(taskG.lookupUspsZone("303", "60601"))}`);
// From McCarran/Reno (894): a nearby Reno ZIP is local (zone 1), Atlanta is
// zone 8 (the reverse of the ATL->West Coast lane), and Chicago is zone 7.
assert(taskG.lookupUspsZone("894", "89434").zone === "1", `RNO->89434 local, got ${JSON.stringify(taskG.lookupUspsZone("894", "89434"))}`);
assert(taskG.lookupUspsZone("894", "30301").zone === "8", `RNO->30301 (Atlanta), got ${JSON.stringify(taskG.lookupUspsZone("894", "30301"))}`);
assert(taskG.lookupUspsZone("894", "60601").zone === "7", `RNO->60601 (Chicago), got ${JSON.stringify(taskG.lookupUspsZone("894", "60601"))}`);
// Bad/short ZIP and unknown origin both fail with an error, not a throw.
assert(!!taskG.lookupUspsZone("303", "123").error, "short ZIP -> error");
assert(!!taskG.lookupUspsZone("999", "30301").error, "unknown origin ZIP3 -> error");

// ---- Bracket-mode manual card ----
{
  const card = taskG.emptyManualCard("UK", "UK test card", "kg", "cm");
  taskG.addZone(card, "Local");
  taskG.addZone(card, "EU");
  card.zones = card.zones.filter((z) => z !== "All"); // drop the default seed zone for this test
  card.brackets = [
    { min: 0, max: 5, prices: { Local: 20, EU: 35 } },
    { min: 5.0001, max: 20, prices: { Local: 45, EU: 70 } },
  ];
  card.countryZoneMap = { "United Kingdom": "Local", Germany: "EU", France: "EU" };

  const q1 = taskG.quoteFreight({ card, totalWeightKg: 3, parcelCount: 1, dest: { country: "United Kingdom" } });
  assert(!q1.error && close(q1.perParcelCost, 20), `UK 3kg local bracket, got ${JSON.stringify(q1)}`);

  const q2 = taskG.quoteFreight({ card, totalWeightKg: 10, parcelCount: 1, dest: { country: "Germany" } });
  assert(!q2.error && close(q2.totalCost, 70), `DE 10kg EU bracket, got ${JSON.stringify(q2)}`);

  // 2 parcels of a 10kg shipment -> 5kg each -> still in the first bracket (<=5kg) per parcel.
  const q3 = taskG.quoteFreight({ card, totalWeightKg: 10, parcelCount: 2, dest: { country: "Germany" } });
  assert(!q3.error && close(q3.perParcelCost, 35) && close(q3.totalCost, 70), `DE 10kg/2 parcels, got ${JSON.stringify(q3)}`);

  // Weight beyond every bracket, splitting not enabled (the default) ->
  // "quote required", not a silent 0/NaN and not a bare error either.
  const qOver = taskG.quoteFreight({ card, totalWeightKg: 100, parcelCount: 1, dest: { country: "Germany" } });
  assert(qOver.quoteRequired === true && !qOver.error, `weight beyond all brackets with splitting disabled should be "quote required", got ${JSON.stringify(qOver)}`);

  // Country with no mapping and no explicit zone -> error, not a guess.
  const qUnmapped = taskG.quoteFreight({ card, totalWeightKg: 3, parcelCount: 1, dest: { country: "Spain" } });
  assert(!!qUnmapped.error, `unmapped country should error, got ${JSON.stringify(qUnmapped)}`);
}

// ---- perUnit-mode manual card (base + per-kg rate + minimum) ----
{
  const card = taskG.emptyManualCard("NL", "NL test card", "kg", "cm");
  card.mode = "perUnit";
  card.perUnit = { All: { base: 5, rate: 3, min: 15 } };
  const qSmall = taskG.quoteFreight({ card, totalWeightKg: 1, parcelCount: 1, dest: { zone: "All" } });
  // base(5) + rate*weight(3) = 8, below the 15 minimum -> minimum applies.
  assert(!qSmall.error && close(qSmall.perParcelCost, 15), `perUnit under minimum, got ${JSON.stringify(qSmall)}`);
  const qBig = taskG.quoteFreight({ card, totalWeightKg: 10, parcelCount: 1, dest: { zone: "All" } });
  // base(5) + rate*weight(30) = 35, above minimum.
  assert(!qBig.error && close(qBig.perParcelCost, 35), `perUnit above minimum, got ${JSON.stringify(qBig)}`);
}

// ---- Dimensional (volumetric) weight overriding actual weight ----
{
  const card = taskG.emptyManualCard("US_GPS", "GPS test card", "lb", "in");
  card.dimDivisor = 139;
  card.brackets = [
    { min: 0, max: 10, prices: { All: 20 } },
    { min: 10.0001, max: 100, prices: { All: 60 } },
  ];
  // Actual weight is tiny (1kg ~= 2.2lb) but a big bulky box (20x20x20in /139
  // = ~57.6lb) should push this into the higher bracket via volumetric weight.
  const q = taskG.quoteFreight({
    card, totalWeightKg: 1, parcelCount: 1,
    dims: { length: 20, width: 20, height: 20, unit: "in" },
    dest: { zone: "All" },
  });
  assert(!q.error && close(q.perParcelCost, 60), `volumetric weight should win over tiny actual weight, got ${JSON.stringify(q)}`);
}

// ---- USPS zone-based card end to end (Stord ATL) ----
{
  const card = taskG.emptyUspsCard("US_STORD_ATL", "Stord ATL test card", "lb", "in");
  card.brackets = [
    { min: 0, max: 5, prices: Object.fromEntries(card.zones.map((z) => [z, Number(z) * 2])) },
  ];
  const qLocal = taskG.quoteFreight({ card, totalWeightKg: 1, parcelCount: 1, dest: { zip: "30301" } });
  assert(!qLocal.error && qLocal.zone === "1" && close(qLocal.perParcelCost, 2), `Stord ATL local zone 1, got ${JSON.stringify(qLocal)}`);
  const qFar = taskG.quoteFreight({ card, totalWeightKg: 1, parcelCount: 1, dest: { zip: "90210" } });
  assert(!qFar.error && qFar.zone === "8" && close(qFar.perParcelCost, 16), `Stord ATL far zone 8, got ${JSON.stringify(qFar)}`);
}

// ---- flatSurcharge (e.g. always-on fuel/peak-season fees) ----
{
  const card = taskG.emptyManualCard("UK", "flat surcharge test card", "kg", "cm");
  card.brackets = [{ min: 0, max: 5, prices: { All: 10 } }];
  card.flatSurcharge = 0.17;
  const q = taskG.quoteFreight({ card, totalWeightKg: 2, parcelCount: 3, dest: { zone: "All" } });
  assert(!q.error && close(q.baseCost, 10) && close(q.flatSurcharge, 0.17) && close(q.perParcelCost, 10.17) && close(q.totalCost, 30.51),
    `flatSurcharge should add per parcel, got ${JSON.stringify(q)}`);
}

// ---- Real UK (OPS-WH02) rate cards seeded from the Royal Mail / DPD /
// Evri / Yodel rate card (RS UK eFulfillment Rate_VIP4.1_IM8_2026.9.21.xlsx,
// 2026-09-22 — supersedes the prior "...2026.4.1.xlsx" version) ----
{
  const rm = taskG.ukRoyalMailCard();
  // 1.5kg to a mainland (Area 1) address: base 2.30 + flat surcharge 0.17.
  const qLocal = taskG.quoteFreight({ card: rm, totalWeightKg: 1.5, parcelCount: 1, dest: { zone: "Area 1" } });
  assert(!qLocal.error && close(qLocal.perParcelCost, 2.47), `Royal Mail Area 1 0-2kg, got ${JSON.stringify(qLocal)}`);
  // 3kg to Area 3 (remote-area surcharge already folded into the bracket price): 7.10 + 0.17.
  const qRemote = taskG.quoteFreight({ card: rm, totalWeightKg: 3, parcelCount: 1, dest: { zone: "Area 3" } });
  assert(!qRemote.error && close(qRemote.perParcelCost, 7.27), `Royal Mail Area 3 2.01-5kg, got ${JSON.stringify(qRemote)}`);

  const dpdUk = taskG.ukDpdUkCard();
  // Northern Ireland (Zone 4): base 13.00 + NI Clearance Surcharge 0.60
  // (baked into the bracket price) + the new DPD Temporary Fuel
  // Surcharge 0.15 (flatSurcharge) = 13.75.
  const qNi = taskG.quoteFreight({ card: dpdUk, totalWeightKg: 5, parcelCount: 1, dest: { zone: "Zone 4" } });
  assert(!qNi.error && close(qNi.perParcelCost, 13.75), `DPD UK Zone 4 (Northern Ireland), got ${JSON.stringify(qNi)}`);
  // 48kg over the 30kg priced ceiling should split (30 + 18kg), not error
  // out — reported: "48.00 kg exceeds this card's maximum of 30 kg...
  // splitting isn't enabled".
  assert(dpdUk.splitAllowed === true, `DPD UK should allow splitting over its 30kg priced ceiling, got splitAllowed=${dpdUk.splitAllowed}`);
  const qDpdUkHeavy = taskG.quoteFreight({ card: dpdUk, totalWeightKg: 48, parcelCount: 1, dest: { zone: "Zone 1" } });
  assert(!qDpdUkHeavy.error && !qDpdUkHeavy.quoteRequired, `48kg DPD UK Zone 1 should split rather than error, got ${JSON.stringify(qDpdUkHeavy)}`);
  assert(Array.isArray(qDpdUkHeavy.split) && qDpdUkHeavy.split.length === 2 && close(qDpdUkHeavy.split[0].weight, 30) && close(qDpdUkHeavy.split[1].weight, 18), `48kg should split into 30+18kg, got ${JSON.stringify(qDpdUkHeavy.split)}`);
  assert(qDpdUkHeavy.packingConfirmationRequired === true, "a split DPD UK quote should be flagged as needing packing confirmation");

  const dpdEmna = taskG.ukDpdEmnaCard();
  // Country -> zone resolution should work directly off the country name (identity map).
  const qUae = taskG.quoteFreight({ card: dpdEmna, totalWeightKg: 2, parcelCount: 1, dest: { country: "UAE" } });
  assert(!qUae.error && close(qUae.perParcelCost, 30.6), `DPD-EMNA UAE 0-2kg, got ${JSON.stringify(qUae)}`);
  const qIsrael = taskG.quoteFreight({ card: dpdEmna, totalWeightKg: 10, parcelCount: 1, dest: { country: "israel" } }); // case-insensitive
  assert(!qIsrael.error && close(qIsrael.perParcelCost, 174.3), `DPD-EMNA Israel 5.01-10kg, got ${JSON.stringify(qIsrael)}`);
  // Norway was dropped from this service in the 2026-09-21 rate sheet — should refuse, not guess.
  const qNorway = taskG.quoteFreight({ card: dpdEmna, totalWeightKg: 1, parcelCount: 1, dest: { country: "Norway" } });
  assert(!!qNorway.error, `DPD-EMNA no longer serves Norway — should refuse rather than guess, got ${JSON.stringify(qNorway)}`);

  // Currency is carried on every card and surfaced on every quote.
  assert(rm.currency === "GBP" && qLocal.currency === "GBP", `UK cards should be priced in GBP, got card=${rm.currency} quote=${qLocal.currency}`);

  // Evri (new this version): 4 speed/POD tiers, 2 weight brackets each.
  const evri48 = taskG.ukEvri48hCard();
  const qEvriSmall = taskG.quoteFreight({ card: evri48, totalWeightKg: 1, parcelCount: 1, dest: { zone: "Zone 1" } });
  assert(!qEvriSmall.error && close(qEvriSmall.perParcelCost, 2.75), `Evri 48H Zone 1 Small (0-1.5kg), got ${JSON.stringify(qEvriSmall)}`);
  const qEvriMed = taskG.quoteFreight({ card: evri48, totalWeightKg: 5, parcelCount: 1, dest: { zone: "Zone 4" } });
  assert(!qEvriMed.error && close(qEvriMed.perParcelCost, 9), `Evri 48H Zone 4 Medium (1.51-15kg), got ${JSON.stringify(qEvriMed)}`);
  const qEvriPod = taskG.quoteFreight({ card: taskG.ukEvri24hPodCard(), totalWeightKg: 1, parcelCount: 1, dest: { zone: "Zone 1" } });
  assert(!qEvriPod.error && close(qEvriPod.perParcelCost, 4.55), `Evri 24H (with POD) Zone 1 Small, got ${JSON.stringify(qEvriPod)}`);
  // >15kg reclassifies to Evri's unpriced "Light & Large" service — refuse, don't guess.
  const qEvriOver = taskG.quoteFreight({ card: evri48, totalWeightKg: 16, parcelCount: 1, dest: { zone: "Zone 1" } });
  assert(!!qEvriOver.quoteRequired, `Evri >15kg should require a manual quote, got ${JSON.stringify(qEvriOver)}`);

  // Yodel (new this version): weight-tiered ladder + a real 3.2% fuel surcharge.
  const yodel48 = taskG.ukYodel48hCard();
  const qYodelSmall = taskG.quoteFreight({ card: yodel48, totalWeightKg: 2, parcelCount: 1, dest: { zone: "Zone A" } });
  assert(!qYodelSmall.error && close(qYodelSmall.perParcelCost, 2.7 * 1.032, 0.01), `Yodel 48H Zone A Small (0-3kg) incl. 3.2% fuel surcharge, got ${JSON.stringify(qYodelSmall)}`);
  const qYodelMed = taskG.quoteFreight({ card: yodel48, totalWeightKg: 5, parcelCount: 1, dest: { zone: "Zone A" } });
  assert(!qYodelMed.error && close(qYodelMed.perParcelCost, 4.2 * 1.032, 0.01), `Yodel 48H Zone A Medium (3.01-17kg) incl. fuel surcharge, got ${JSON.stringify(qYodelMed)}`);
  // 24H isn't offered to Zone B (remote areas) at all — refuse, don't guess.
  const qYodel24Remote = taskG.quoteFreight({ card: taskG.ukYodel24hCard(), totalWeightKg: 5, parcelCount: 1, dest: { zone: "Zone B" } });
  assert(!!qYodel24Remote.error, `Yodel 24H isn't offered to Zone B — should refuse rather than guess, got ${JSON.stringify(qYodel24Remote)}`);
  // Yodel explicitly refuses packages over 30kg outright — should split
  // into multiple real sub-30kg parcels rather than error out.
  assert(yodel48.splitAllowed === true && yodel48.maxPhysicalWeight === 30, `Yodel 48H should allow splitting up to its stated 30kg physical max, got splitAllowed=${yodel48.splitAllowed} maxPhysicalWeight=${yodel48.maxPhysicalWeight}`);
  const qYodelHeavy = taskG.quoteFreight({ card: yodel48, totalWeightKg: 48, parcelCount: 1, dest: { zone: "Zone A" } });
  assert(!qYodelHeavy.error && !qYodelHeavy.quoteRequired, `48kg Yodel 48H Zone A should split rather than error, got ${JSON.stringify(qYodelHeavy)}`);
  assert(Array.isArray(qYodelHeavy.split) && qYodelHeavy.split.length === 2 && close(qYodelHeavy.split[0].weight, 30) && close(qYodelHeavy.split[1].weight, 18), `48kg should split into 30+18kg, got ${JSON.stringify(qYodelHeavy.split)}`);
  assert(qYodelHeavy.packingConfirmationRequired === true, "a split Yodel quote should be flagged as needing packing confirmation");

  // defaultRateCards() should wire in all 9 UK cards.
  const ukDefaults = taskG.defaultRateCards().UK;
  assert(ukDefaults.length === 9, `UK defaults should have 9 cards, got ${ukDefaults.length}: ${JSON.stringify(ukDefaults.map((c) => c.name))}`);
  assert(ukDefaults.every((c) => c.currency === "GBP"), "every UK default card should be priced in GBP");
}

// ---- Real US GPS (USOPS-WH04) rate cards, imported from "IM8 2025 GPS
// US2Global eCom Parcel Rate-Premium v2.xlsx" (provided by the user
// 2026-09-11) via parseUsToGlobalRateSheet — seeded as the GPS default
// despite being expired, per explicit instruction ("use this expired
// rate card to proceed first"). ----
{
  const ddp = taskG.gpsDdpCard();
  const ddu = taskG.gpsDduCard();
  assert(ddp.currency === "USD" && ddu.currency === "USD", `GPS cards should be priced in USD, got ddp=${ddp.currency} ddu=${ddu.currency}`);
  assert(ddp.zones.length === 41 && ddu.zones.length === 231, `GPS DDP/DDU zone counts, got ddp=${ddp.zones.length} ddu=${ddu.zones.length}`);
  assert(ddp.zones.includes("Canada") && ddu.zones.includes("Canada"), "both GPS cards should include Canada as a destination");

  // 0.5lb to Canada should hit the first bracket on both cards.
  const halfLbInKg = taskG.convertWeight(0.5, "lb", "kg");
  const qDdp = taskG.quoteFreight({ card: ddp, totalWeightKg: halfLbInKg, parcelCount: 1, dest: { country: "Canada" } });
  assert(!qDdp.error && close(qDdp.perParcelCost, 8.3) && qDdp.currency === "USD", `GPS DDP Canada 0.5lb, got ${JSON.stringify(qDdp)}`);
  const qDdu = taskG.quoteFreight({ card: ddu, totalWeightKg: halfLbInKg, parcelCount: 1, dest: { country: "Canada" } });
  assert(!qDdu.error && close(qDdu.perParcelCost, 11.07), `GPS DDU Canada 0.5lb, got ${JSON.stringify(qDdu)}`);

  // Both cards are past their expiry (2025-09-30) as of any date this test
  // suite realistically runs on — every quote must say so.
  assert(qDdp.expired === true && qDdu.expired === true, "GPS cards are expired (2025-09-30) and every quote should be flagged as such");

  // defaultRateCards() should wire these in directly for US_GPS (not a
  // blank starter card) — this is what makes the warehouse usable out of
  // the box despite no fresh rate card being available yet. (The other 6
  // GPS cards — local + international — are checked further down.)
  const defaults = taskG.defaultRateCards();
  const ddpDdu = defaults.US_GPS.filter((c) => c.name.includes("US to Global"));
  assert(ddpDdu.length === 2 && ddpDdu.every((c) => c.currency === "USD"), `US_GPS defaults should include the two DDP/DDU cards, got ${JSON.stringify(defaults.US_GPS.map((c) => c.name))}`);
}

// ---- parseUsToGlobalRateSheet: GPS-style "Destinations x weight-break"
// international rate sheets, too large to hand-type or bake into source
// (real cards run 40-190 countries x 60+ weight rows) — parsed from the
// sheet's own layout at import time instead. Fixture mirrors the real
// "IM8 ... GPS US2Global eCom Parcel Rate" sheet shape (see
// ukRoyalMailCard() etc. for the equivalent small, hand-entered UK cards).
{
  const fixtureRows = [
    [],
    ["GPS International Priority Parcel - US Export"],
    ["Effective Date: ", "", 45658],
    ["Expired Date: ", "", 45930],
    ["Currency: ", "", "USD"],
    ["Destinations", "Canada", "United Kingdom"],
    ["ISO", "CA", "GB"],
    ["Terms", "DDP", "DDP"],
    ["Dim Factor", 139, 139],
    ["Minimum", 0, 0],
    ["LB\\Transit Time", "5-8WD", "5-7WD"],
    ["0.5", 8.3, 5],
    [1, 8.97, 5.22],
    [2, 10.15, 6.74],
  ];
  const { card, error } = taskG.parseUsToGlobalRateSheet(fixtureRows, { warehouseId: "US_GPS" });
  assert(!error, `parse should succeed on a well-formed sheet, got error: ${error}`);
  assert(card && card.zones.length === 2 && card.zones[0] === "Canada" && card.zones[1] === "United Kingdom", `zones from Destinations row, got ${JSON.stringify(card && card.zones)}`);
  assert(card.countryZoneMap.Canada === "Canada", "countryZoneMap should be an identity map for a country-per-column sheet");
  assert(card.dimDivisor === 139, `dimDivisor from Dim Factor row, got ${card.dimDivisor}`);
  assert(card.effectiveDate === "2025-01-01", `effectiveDate from numeric Excel serial 45658, got ${card.effectiveDate}`);
  assert(card.expiryDate === "2025-09-30", `expiryDate from numeric Excel serial 45930, got ${card.expiryDate}`);
  assert(card.brackets.length === 3, `3 weight-break rows -> 3 brackets, got ${card.brackets.length}`);
  assert(close(card.brackets[0].min, 0) && close(card.brackets[0].max, 0.5) && close(card.brackets[0].prices.Canada, 8.3), `first bracket, got ${JSON.stringify(card.brackets[0])}`);
  assert(close(card.brackets[1].min, 0.51) && close(card.brackets[1].max, 1) && close(card.brackets[1].prices["United Kingdom"], 5.22), `second bracket, got ${JSON.stringify(card.brackets[1])}`);
  assert(card.notes.includes("DDP") && card.notes.includes("2025-01-01"), `notes should carry terms + dates, got "${card.notes}"`);

  // End-to-end: a 1lb shipment to Canada should land in the 0.51-1lb bracket.
  const oneLbInKg = taskG.convertWeight(1, "lb", "kg");
  const q = taskG.quoteFreight({ card, totalWeightKg: oneLbInKg, parcelCount: 1, dest: { country: "Canada" } });
  assert(!q.error && close(q.perParcelCost, 8.97, 1e-6), `1lb to Canada should price the 0.51-1lb bracket, got ${JSON.stringify(q)}`);
  assert(q.expired === true, "a card expired in 2025 should be flagged expired (test runs well after that)");

  // The date value comes through as a JS Date object (not a raw serial)
  // whenever the workbook is read with cellDates:true — which is exactly
  // what the real app's io.loadWorkbook() does — so that path needs to
  // work too, not just the raw-serial one exercised above.
  const dateFixtureRows = fixtureRows.map((r) => r.slice());
  dateFixtureRows[2] = ["Effective Date: ", "", new Date(Date.UTC(2025, 0, 1))];
  dateFixtureRows[3] = ["Expired Date: ", "", new Date(Date.UTC(2025, 8, 30))];
  const dateResult = taskG.parseUsToGlobalRateSheet(dateFixtureRows, { warehouseId: "US_GPS" });
  assert(!dateResult.error && dateResult.card.effectiveDate === "2025-01-01" && dateResult.card.expiryDate === "2025-09-30",
    `should parse Date-object date cells too, got ${JSON.stringify(dateResult)}`);

  // A non-zero Minimum charge isn't applied automatically — should be
  // called out in notes rather than silently dropped.
  const minFixtureRows = fixtureRows.map((r) => r.slice());
  minFixtureRows[9] = ["Minimum", 15, 15];
  const minResult = taskG.parseUsToGlobalRateSheet(minFixtureRows, { warehouseId: "US_GPS" });
  assert(!minResult.error && /minimum/i.test(minResult.card.notes), `non-zero Minimum row should be flagged in notes, got "${minResult.card && minResult.card.notes}"`);

  // Missing the "Destinations" row entirely -> a clear error, not a throw.
  const badResult = taskG.parseUsToGlobalRateSheet([["not a rate sheet"]], {});
  assert(!!badResult.error, "a sheet with no Destinations row should error, not throw or silently return garbage");
}

// ---- parseUsDomesticZoneSheet: "Zone N" (or bare zone-number) columns x
// lb/oz weight rows — the shape used by GPS's own USPS/UPS Ground/FedEx
// Ground domestic sheets. Fixture mirrors USPS Ground Advantage's real
// shape: an oz-indexed block (<1lb) followed by an lb-indexed block
// reusing the same zone columns, both stitched into one bracket ladder. ----
{
  const fixtureRows = [
    [],
    ["USPS Ground Advantage Package Service"],
    ["Rate Category (oz.)", "ZONE 1", "ZONE 2"],
    [1, 3.67, 3.7],
    [2, 3.67, 3.7],
    ["Rate Category（lb）", "ZONE 1", "ZONE 2"],
    [1, 5.96, 5.98],
    [2, 6.2, 6.23],
    ["Oversized", 93.05, 103.15],
  ];
  const { card, error } = taskG.parseUsDomesticZoneSheet(fixtureRows, { warehouseId: "US_GPS", cardName: "USPS GA test", dimDivisor: 166 });
  assert(!error, `parse should succeed on a well-formed sheet, got error: ${error}`);
  assert(card.zones.length === 2 && card.zones[0] === "1" && card.zones[1] === "2", `zones from ZONE header columns, got ${JSON.stringify(card && card.zones)}`);
  assert(card.dimDivisor === 166, `dimDivisor passed through from opts, got ${card.dimDivisor}`);
  // oz block: 2 rows -> brackets at 1/16=0.0625lb and 2/16=0.125lb.
  assert(card.brackets.length === 4, `2 oz rows + 2 lb rows -> 4 brackets ("Oversized" should not add a 5th), got ${card.brackets.length}`);
  assert(close(card.brackets[0].min, 0) && close(card.brackets[0].max, 0.0625) && close(card.brackets[0].prices["1"], 3.67), `first (1oz) bracket, got ${JSON.stringify(card.brackets[0])}`);
  assert(close(card.brackets[1].max, 0.125), `second (2oz) bracket max, got ${card.brackets[1].max}`);
  // lb block continues right after the oz block, in the same ladder.
  assert(close(card.brackets[2].max, 1) && close(card.brackets[2].prices["1"], 5.96), `third (1lb) bracket, got ${JSON.stringify(card.brackets[2])}`);
  assert(close(card.brackets[3].max, 2) && close(card.brackets[3].prices["2"], 6.23), `fourth (2lb) bracket, got ${JSON.stringify(card.brackets[3])}`);

  // A Commercial | Residential side-by-side layout (real UPS Ground shape)
  // should only pick up the first (Commercial) block, stopping at the gap.
  const sideBySideRows = [
    ["Lbs.", "Zone 2", "Zone 3", null, "Lbs.", "Zone 2", "Zone 3"],
    [1, 7.23, 7.23, null, 1, 7.13, 7.13],
    [2, 7.23, 7.23, null, 2, 7.13, 7.13],
  ];
  const sbs = taskG.parseUsDomesticZoneSheet(sideBySideRows, {});
  assert(!sbs.error && sbs.card.zones.length === 2, `should stop at the gap column (Commercial only), got zones=${JSON.stringify(sbs.card && sbs.card.zones)}`);

  // Missing header row -> a clear error.
  const badResult = taskG.parseUsDomesticZoneSheet([["nothing here"]], {});
  assert(!!badResult.error, "a sheet with no weight x zone header should error, not throw");
}

// ---- parseUsDomesticZoneSheet: named zones + multiple named sections in
// one sheet + a "pretty name" row that introduces no weight data of its
// own — the shape used by Stord's own multi-service "RATE CARD" sheet
// (ECONOMY/GROUND STANDARD/etc. sections with named zones like "Hawaii";
// a "Priority DDP" section whose header stacks a row of full country
// names directly above a row of 2-letter codes, re-used again by a
// second oz->lb header block further down the SAME section). ----
{
  const fixtureRows = [
    ["ECONOMY"],
    ["Weight", "ZONES"],
    ["Ounces (OZ)", 2, 3, "Hawaii", "Alaska"],
    [1, 4.28, 4.32, 5.03, 5.03],
    [],
    ["GROUND STANDARD COMMERCIAL"],
    ["Weight (LB)", "ZONES"],
    [null, 2, 3, "Hawaii", "Alaska"],
    [1, 10.9, 10.9, 31.2, 32.2],
    [],
    ["Priority DDP"],
    ["Weight", "ZONES"],
    [null, "Australia", "Belgium"],
    ["Ounces (OZ)", "AU", "BE"],
    [1, 112.86, 104.04],
    [16, 117.16, 108],
    ["Pounds (LB)", "AU", "BE"], // a second header block, same section, no adjacent name row of its own
    [5, 199.67, 190],
  ];
  const economy = taskG.parseUsDomesticZoneSheet(fixtureRows, { sectionLabel: "ECONOMY" });
  assert(!economy.error && economy.card.zones.includes("Hawaii") && economy.card.zones.includes("Alaska"),
    `named zones (Hawaii/Alaska) should be captured, got ${JSON.stringify(economy.card && economy.card.zones)}`);
  assert(close(economy.card.brackets[0].prices.Hawaii, 5.03), `Hawaii price, got ${economy.card && JSON.stringify(economy.card.brackets[0])}`);

  const groundComm = taskG.parseUsDomesticZoneSheet(fixtureRows, { sectionLabel: "GROUND STANDARD COMMERCIAL" });
  assert(!groundComm.error && groundComm.card.zones.length === 4, `sectionLabel should isolate just this section's zones, got ${JSON.stringify(groundComm.card && groundComm.card.zones)}`);
  assert(close(groundComm.card.brackets[0].prices["2"], 10.9), `Ground Standard Commercial zone 2, got ${groundComm.card && JSON.stringify(groundComm.card.brackets[0])}`);

  // The trickiest part: a display-name-only row (no weight data on the
  // very next line) must apply to EVERY header block in its section, not
  // just the one immediately below it — Priority DDP's oz block picks up
  // the country names directly, but the later lb block (a fresh header
  // with no name row of its own right above it) must inherit them too,
  // otherwise its prices land under "AU"/"BE" instead of the country name
  // used everywhere else and silently vanish from the country's own
  // bracket ladder.
  const ddp = taskG.parseUsDomesticZoneSheet(fixtureRows, { sectionLabel: "Priority DDP", buildCountryZoneMap: true });
  assert(!ddp.error, `parse should succeed, got error: ${ddp.error}`);
  assert(ddp.card.zones.includes("Australia") && !ddp.card.zones.includes("AU"),
    `zones should be full country names, not codes, got ${JSON.stringify(ddp.card && ddp.card.zones)}`);
  assert(ddp.card.brackets.length === 3, `2 oz rows + 1 lb row -> 3 brackets, got ${ddp.card.brackets.length}`);
  const lbBracket = ddp.card.brackets[ddp.card.brackets.length - 1];
  assert(close(lbBracket.prices.Australia, 199.67), `the later lb header block must inherit the country names too, got ${JSON.stringify(lbBracket)}`);
  const q = taskG.quoteFreight({ card: ddp.card, totalWeightKg: taskG.convertWeight(5, "lb", "kg"), parcelCount: 1, dest: { country: "Australia" } });
  assert(!q.error && close(q.perParcelCost, 199.67), `5lb to Australia via the lb block, got ${JSON.stringify(q)}`);
}

// ---- parseUpsWorldwideExpeditedSheets: UPS's own numeric zone codes,
// resolved from a destination country via a separate Export Zones sheet
// (Western vs. Eastern U.S. origin columns) — plus the rate sheet's own
// "Destination" row for a few countries (e.g. Canada) called out directly
// under specific zone columns rather than via the country lookup. ----
{
  const rateRows = [
    ["Zones", null, null, "71", "72", "601"],
    ["Destination", null, null, "Canada", "Canada", " "],
    ["Cntr", "Rate Type", "lbs", " ", " ", " "],
    ["Pkg", "Per Shp", "1", 15.69, 16.77, 18.14],
    ["Pkg", "Per Shp", "2", 16.58, 18.56, 20.8],
    ["Pkg", "Per Lb", "9999999", 0.99, 1, 1.51],
  ];
  const exportZonesRows = [
    ["Destination", "UPS Worldwide", "UPS Worldwide"],
    ["Country", "ExpeditedSM", "ExpeditedSM"],
    [null, "Originating from", "Originating from"],
    [null, "Western U.S.", "Eastern U.S."],
    [],
    ["United Kingdom / GB", 601, 601],
    ["Japan / JP", 613, 613],
  ];
  const { card, error } = taskG.parseUpsWorldwideExpeditedSheets(rateRows, exportZonesRows, { warehouseId: "US_GPS", cardName: "UPS Intl test" });
  assert(!error, `parse should succeed, got error: ${error}`);
  assert(card.zones.length === 3 && card.zones.includes("601"), `zone codes from the Zones header row, got ${JSON.stringify(card && card.zones)}`);
  assert(card.countryZoneMap["United Kingdom"] === "601", `country -> zone from Export Zones (name stripped of " / GB"), got ${JSON.stringify(card.countryZoneMap)}`);
  assert(card.countryZoneMap.Canada === "71", `Canada should resolve from the rate sheet's own Destination row (first zone column it appears under), got ${card.countryZoneMap.Canada}`);
  assert(!("Japan" in card.countryZoneMap) === false, "Japan should be in the map too"); // sanity: map isn't accidentally limited to 1 entry
  // Weights beyond the flat table ("Per Lb" row) aren't modeled as a bracket.
  assert(card.brackets.length === 2, `"Per Lb" row should stop the bracket ladder, not become a 3rd bracket, got ${card.brackets.length}`);
  assert(/per\s*lb/i.test(card.notes) || /additional lb/i.test(card.notes), `notes should mention the unmodeled Per Lb tier, got "${card.notes}"`);

  const q = taskG.quoteFreight({ card, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { country: "United Kingdom" } });
  assert(!q.error && close(q.perParcelCost, 18.14), `UK 1lb via country lookup, got ${JSON.stringify(q)}`);
  const qCanada = taskG.quoteFreight({ card, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { country: "Canada" } });
  assert(!qCanada.error && close(qCanada.perParcelCost, 15.69), `Canada 1lb via Destination-row lookup, got ${JSON.stringify(qCanada)}`);

  // Missing "Zones" header -> a clear error.
  const badResult = taskG.parseUpsWorldwideExpeditedSheets([["nothing here"]], exportZonesRows, {});
  assert(!!badResult.error, "a rate sheet with no Zones header should error, not throw");
}

// ---- Real US GPS (USOPS-WH04) local + international rate cards, from
// "2025 GPS eFulfillment Rate A1.2.xlsx" and "250707 GPS UPS International
// Rates v1.xlsx" (provided by the user 2026-09-11), seeded into
// defaultRateCards().US_GPS alongside the earlier DDP/DDU cards. ----
{
  const defaults = taskG.defaultRateCards();
  const gps = defaults.US_GPS;
  assert(gps.length === 8, `US_GPS should have 8 default cards (2 US2Global + 5 domestic + 1 UPS intl), got ${gps.length}: ${gps.map((c) => c.name).join(", ")}`);
  assert(gps.every((c) => c.currency === "USD"), "every GPS card should be priced in USD");

  const ga = gps.find((c) => c.name.includes("Ground Advantage"));
  const qGa = taskG.quoteFreight({ card: ga, totalWeightKg: taskG.convertWeight(0.5, "lb", "kg"), parcelCount: 1, dest: { zone: "1" } });
  assert(!qGa.error && close(qGa.perParcelCost, 3.67), `USPS Ground Advantage 0.5lb zone 1, got ${JSON.stringify(qGa)}`);

  const upsGround = gps.find((c) => c.name === "GPS UPS Ground");
  const qUps = taskG.quoteFreight({ card: upsGround, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zone: "2" } });
  assert(!qUps.error && close(qUps.perParcelCost, 7.23) && upsGround.dimDivisor === 225, `UPS Ground 1lb zone 2, got ${JSON.stringify(qUps)}`);

  const upsIntl = gps.find((c) => c.name.includes("Worldwide Expedited"));
  const qJapan = taskG.quoteFreight({ card: upsIntl, totalWeightKg: taskG.convertWeight(2, "lb", "kg"), parcelCount: 1, dest: { country: "Japan" } });
  assert(!qJapan.error && close(qJapan.perParcelCost, 19.83), `UPS Worldwide Expedited 2lb to Japan, got ${JSON.stringify(qJapan)}`);
  assert(!qJapan.expired, "GPS local/international cards have no stated expiry date, so shouldn't be auto-flagged expired");
}

// ---- percentSurcharge (e.g. a carrier's fuel surcharge quoted as a % of
// the base rate rather than a flat fee) ----
{
  const card = taskG.emptyManualCard("NL", "percent surcharge test card", "kg", "cm");
  card.brackets = [{ min: 0, max: 5, prices: { All: 10 } }];
  card.percentSurcharge = 0.03;
  card.flatSurcharge = 0.5;
  const q = taskG.quoteFreight({ card, totalWeightKg: 2, parcelCount: 1, dest: { zone: "All" } });
  // 10 * 1.03 = 10.30, + flat 0.50 = 10.80.
  assert(!q.error && close(q.percentAmount, 0.3) && close(q.perParcelCost, 10.8), `percentSurcharge should apply before flatSurcharge, got ${JSON.stringify(q)}`);
}

// ---- parseEuIntraDestinationRowsSheet: DESTINATION rows (one per
// carrier per destination) x weight columns — the shape used by Stord's
// EU-origin intra-EU rate card. Fixture mirrors the real file's trickiest
// bit: a blank spacer row and a footnote row *inside* a single logical
// block (no fresh header in between) must not truncate that block, only
// a genuinely new "DESTINATION" header should start a new one. ----
{
  const fixtureRows = [
    ["DESTINATION", "CARRIER", "TOLL CHARGE", "FUEL SURCHARGE (EXCLUDED)", "0.25kg", "0.5kg"],
    ["AUSTRIA", "SPRING_POST NL", "Included", 0.03, 6.6, 6.6],
    ["AUSTRIA", "DHL_DE: WP", "Included", 0.0125, 7.99, 8.2],
    ["BELGIUM", "SPRING_POST NL", "Included", 0.03, 7.68, 7.68],
    [], // blank spacer row — must not end the SPRING_POST NL/DHL_DE block
    ["SWITZERLAND", "DHL_DE: PI", "Included", 0.0125, 26.4, 26.4],
    [],
    ["1. SOME FOOTNOTE:", null, null, "TEXT, NO WEIGHT DATA"], // no weight-column data -> skipped, not a zone
    [],
    ["DESTINATION (MIDDLE EAST)", "CARRIER", "TOLL CHARGE", "FUEL SURCHARGE (EXCLUDED)", "0.25kg", "0.5kg"],
    ["ISRAEL", "DPD", "Included", 0.16, 28.3, 28.3],
  ];
  const { cards, error } = taskG.parseEuIntraDestinationRowsSheet(fixtureRows, { warehouseId: "NL", cardNamePrefix: "NL test" });
  assert(!error, `parse should succeed, got error: ${error}`);
  assert(cards.length === 4, `4 distinct carriers (SPRING_POST NL, DHL_DE: WP, DHL_DE: PI, DPD) -> 4 cards, got ${cards.length}: ${cards.map((c) => c.name).join(", ")}`);

  const spring = cards.find((c) => c.name.includes("SPRING_POST"));
  assert(spring && spring.zones.length === 2 && spring.zones.includes("AUSTRIA") && spring.zones.includes("BELGIUM"),
    `SPRING_POST should have both Austria and Belgium (blank row must not truncate it), got ${JSON.stringify(spring && spring.zones)}`);
  assert(close(spring.percentSurcharge, 0.03), `SPRING_POST fuel %, got ${spring.percentSurcharge}`);

  const dhlWp = cards.find((c) => c.name.includes("DHL_DE: WP"));
  assert(dhlWp && dhlWp.zones.length === 1 && dhlWp.zones[0] === "AUSTRIA", `DHL_DE: WP should only have Austria, got ${JSON.stringify(dhlWp && dhlWp.zones)}`);

  const dhlPi = cards.find((c) => c.name.includes("DHL_DE: PI"));
  assert(dhlPi && dhlPi.zones.length === 1 && dhlPi.zones[0] === "SWITZERLAND",
    `DHL_DE: PI (Switzerland) is separated from the main block by a blank row + footnote row with no new header — must still be picked up, got ${JSON.stringify(dhlPi && dhlPi.zones)}`);
  assert(!dhlPi.zones.includes("1. SOME FOOTNOTE:"), "the footnote row (no weight-column data) must not become a bogus zone");

  const dpd = cards.find((c) => c.name.includes("DPD"));
  assert(dpd && dpd.zones.length === 1 && dpd.zones[0] === "ISRAEL", `the second DESTINATION (MIDDLE EAST) header block should be picked up separately, got ${JSON.stringify(dpd && dpd.zones)}`);

  const q = taskG.quoteFreight({ card: spring, totalWeightKg: 0.25, parcelCount: 1, dest: { country: "AUSTRIA" } });
  assert(!q.error && close(q.baseCost, 6.6) && close(q.percentAmount, 0.2), `Austria 0.25kg via SPRING_POST, got ${JSON.stringify(q)}`);

  // A "-" cell means "not offered", not free — must error, not quote $0.
  const dashRows = fixtureRows.map((r) => r.slice());
  dashRows[3] = ["BELGIUM", "SPRING_POST NL", "Included", 0.03, 7.68, "-"];
  const { cards: dashCards } = taskG.parseEuIntraDestinationRowsSheet(dashRows, { warehouseId: "NL" });
  const springDash = dashCards.find((c) => c.name.includes("SPRING_POST"));
  const qDash = taskG.quoteFreight({ card: springDash, totalWeightKg: 0.5, parcelCount: 1, dest: { country: "BELGIUM" } });
  assert(!!qDash.error, `a "-" cell should error rather than quote free shipping, got ${JSON.stringify(qDash)}`);

  const badResult = taskG.parseEuIntraDestinationRowsSheet([["nothing here"]], {});
  assert(!!badResult.error, "a sheet with no DESTINATION header should error, not throw");
}

// ---- Real NL (OPS-WH03) rate cards, from "IM8_EU-origin-intra-EU-Stord-
// Parcel-10-3-2025.xlsx" (provided by the user 2026-09-11), "2026 EU
// Carrier Rates" tab (the 2025 tab in the same file is superseded, not
// imported) — 6 cards, one per carrier, seeded into
// defaultRateCards().NL. ----
{
  const defaults = taskG.defaultRateCards();
  const nl = defaults.NL;
  assert(nl.length === 6, `NL should have 6 default cards (one per carrier), got ${nl.length}: ${nl.map((c) => c.name).join(", ")}`);
  assert(nl.every((c) => c.currency === "EUR"), "every NL card should be priced in EUR");

  const spring = nl.find((c) => c.name.includes("SPRING_POST"));
  const qGermany = taskG.quoteFreight({ card: spring, totalWeightKg: 0.25, parcelCount: 1, dest: { country: "GERMANY" } });
  assert(!qGermany.error && close(qGermany.perParcelCost, 6.48), `NL Spring/Post 0.25kg to Germany, got ${JSON.stringify(qGermany)}`);

  const dpd = nl.find((c) => c.name.includes("DPD"));
  const qIsrael = taskG.quoteFreight({ card: dpd, totalWeightKg: 0.25, parcelCount: 1, dest: { country: "ISRAEL" } });
  assert(!qIsrael.error && close(qIsrael.baseCost, 28.3) && close(qIsrael.percentSurcharge, 0.16), `NL DPD 0.25kg to Israel, got ${JSON.stringify(qIsrael)}`);
  assert(!qIsrael.expired, "the NL rate card has no stated expiry date, so shouldn't be auto-flagged expired");
}

// ---- Real Stord (USOPS-WH05) rate cards, from "IM8 2026 - STORD
// 20251218.xlsx" (provided by the user 2026-09-11) — 9 services from the
// "RATE CARD" tab, plus 3 more international services (Standard DDP,
// Expedited DDP, Standard DDU) from their own dedicated tabs added
// specifically to make sure Canada is covered (2026-09-14), plus the
// existing blank USPS-zone card — seeded into BOTH
// defaultRateCards().US_STORD_ATL and .US_STORD_RNO (the sheet doesn't
// distinguish an origin). ----
{
  const defaults = taskG.defaultRateCards();
  for (const whId of ["US_STORD_ATL", "US_STORD_RNO"]) {
    const cards = defaults[whId];
    assert(cards.length === 13, `${whId} should have 13 cards (9 RATE CARD services + 3 dedicated-tab international services + the manual-entry USPS-zone card), got ${cards.length}: ${cards.map((c) => c.name).join(", ")}`);
    assert(cards.filter((c) => c.name.startsWith("Stord")).every((c) => c.currency === "USD"), `${whId}'s Stord cards should be priced in USD`);
  }

  const econAtl = defaults.US_STORD_ATL.find((c) => c.name === "Stord Economy");
  const qEcon = taskG.quoteFreight({ card: econAtl, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zone: "2" } });
  assert(!qEcon.error && close(qEcon.perParcelCost, 5.31), `Stord Economy 1lb zone 2, got ${JSON.stringify(qEcon)}`);
  assert(econAtl.zones.includes("Hawaii") && econAtl.zones.includes("APO/FPO"), `Stord Economy should include named zones, got ${JSON.stringify(econAtl.zones)}`);

  const groundCommRno = defaults.US_STORD_RNO.find((c) => c.name === "Stord Ground Standard (Commercial)");
  const qGround = taskG.quoteFreight({ card: groundCommRno, totalWeightKg: taskG.convertWeight(150, "lb", "kg"), parcelCount: 1, dest: { zone: "8" } });
  assert(!qGround.error && close(qGround.baseCost, 96.38) && groundCommRno.dimDivisor === 166, `Stord Ground Standard Commercial 150lb zone 8, got ${JSON.stringify(qGround)}`);

  // Both origins are built from the SAME underlying seed data (the sheet
  // doesn't distinguish Atlanta vs. McCarran) but must still be distinct
  // card instances with their own ids and warehouseId, not aliases of the
  // same object (editing one in the UI must not silently edit the other).
  const econRno = defaults.US_STORD_RNO.find((c) => c.name === "Stord Economy");
  assert(econAtl.id !== econRno.id && econAtl.warehouseId === "US_STORD_ATL" && econRno.warehouseId === "US_STORD_RNO",
    `ATL and RNO cards should be independent instances, got atl.id=${econAtl.id} rno.id=${econRno.id}`);

  const ddpAtl = defaults.US_STORD_ATL.find((c) => c.name.includes("Priority DDP"));
  const qDdp = taskG.quoteFreight({ card: ddpAtl, totalWeightKg: taskG.convertWeight(5, "lb", "kg"), parcelCount: 1, dest: { country: "Australia" } });
  assert(!qDdp.error && close(qDdp.perParcelCost, 139.49), `Stord Priority DDP 5lb to Australia, got ${JSON.stringify(qDdp)}`);
  assert(!qDdp.expired, "the Stord rate card has no stated expiry date, so shouldn't be auto-flagged expired");

  // Reported: "36.74 lb exceeds this card's maximum of 30 lb, and
  // splitting into multiple consignments isn't enabled for this card."
  // Priority DDP's own notes document a real overage rate (+$3.00/lb
  // over the max, min $50) — should price directly via that formula,
  // not error out or fake a multi-parcel split.
  assert(ddpAtl.overageRatePerUnit === 3 && ddpAtl.overageMinCharge === 50 && !ddpAtl.splitAllowed, `Priority DDP should use the documented overage rate, got overageRatePerUnit=${ddpAtl.overageRatePerUnit} overageMinCharge=${ddpAtl.overageMinCharge} splitAllowed=${ddpAtl.splitAllowed}`);
  const qDdpOverage = taskG.quoteFreight({ card: ddpAtl, totalWeightKg: taskG.convertWeight(36.74, "lb", "kg"), parcelCount: 1, dest: { country: "Australia" } });
  assert(!qDdpOverage.error && !qDdpOverage.quoteRequired && !qDdpOverage.split, `36.74lb Priority DDP to Australia should price, not error or split, got ${JSON.stringify(qDdpOverage)}`);
  assert(qDdpOverage.overageApplied === true && close(qDdpOverage.overageAmount, 50) && close(qDdpOverage.totalCost, 541.51), `36.74lb (6.74lb over, ×$3=$20.22 < $50 min) should hit the $50 minimum, top bracket 491.51 + 50 = 541.51, got ${JSON.stringify(qDdpOverage)}`);

  // Canada, specifically — the point of adding these 3 extra cards — must
  // resolve on all three, at meaningfully different (tiered) prices, not
  // just the one card RATE CARD already covered it on.
  const standardDdp = defaults.US_STORD_ATL.find((c) => c.name.includes("Standard DDP"));
  const qStdDdpCanada = taskG.quoteFreight({ card: standardDdp, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { country: "Canada (Major)" } });
  assert(!qStdDdpCanada.error && close(qStdDdpCanada.perParcelCost, 8.98), `Stord Standard DDP 1lb to Canada (Major), got ${JSON.stringify(qStdDdpCanada)}`);

  const expeditedDdp = defaults.US_STORD_ATL.find((c) => c.name.includes("Expedited DDP"));
  const qExpDdpCanada = taskG.quoteFreight({ card: expeditedDdp, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { country: "Canada (Major)" } });
  assert(!qExpDdpCanada.error && close(qExpDdpCanada.perParcelCost, 29.64), `Stord Expedited DDP 1lb to Canada (Major), got ${JSON.stringify(qExpDdpCanada)}`);

  const standardDdu = defaults.US_STORD_ATL.find((c) => c.name.includes("Standard DDU"));
  const qStdDduCanada = taskG.quoteFreight({ card: standardDdu, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { country: "Canada (Major)" } });
  assert(!qStdDduCanada.error && close(qStdDduCanada.perParcelCost, 14.07), `Stord Standard DDU 1lb to Canada (Major), got ${JSON.stringify(qStdDduCanada)}`);
  assert(standardDdu.zones.every((z) => z.length > 3 || /^Canada/.test(z)), `Standard DDU zones should be full country names, not 2-letter codes, got a sample: ${JSON.stringify(standardDdu.zones.slice(0, 10))}`);

  // ---- Reported bug: typing plain "Canada" (as any real user would,
  // not the literal zone label "Canada (Major)") plus a real Canadian
  // postal code should auto-detect Major vs. Rural, not demand a manual
  // pick or (worse) a US ZIP. ----
  assert(taskG.resolveCanadaMajorRural("T1J 1Y6") === "Major", `T1J 1Y6 (2nd char "1") should resolve to Major, got ${taskG.resolveCanadaMajorRural("T1J 1Y6")}`);
  assert(taskG.resolveCanadaMajorRural("K0A 1G0") === "Rural", `K0A 1G0 (2nd char "0") should resolve to Rural, got ${taskG.resolveCanadaMajorRural("K0A 1G0")}`);
  assert(taskG.resolveCanadaMajorRural("not-a-postal-code") === null, "an unrecognizable postal code shape should return null, not guess");

  const zoneMajor = taskG.resolveZone(standardDdp, { country: "Canada", zip: "T1J 1Y6" });
  assert(!zoneMajor.error && zoneMajor.zone === "Canada (Major)" && zoneMajor.autoDetected === true, `plain "Canada" + a major-FSA postcode should auto-detect Canada (Major), got ${JSON.stringify(zoneMajor)}`);
  const zoneRural = taskG.resolveZone(standardDdp, { country: "Canada", zip: "K0A 1G0" });
  assert(!zoneRural.error && zoneRural.zone === "Canada (Rural)" && zoneRural.autoDetected === true, `plain "Canada" + a rural-FSA postcode should auto-detect Canada (Rural), got ${JSON.stringify(zoneRural)}`);
  const qCanadaPlain = taskG.quoteFreight({ card: standardDdp, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { country: "Canada", zip: "T1J1Y6" } });
  assert(!qCanadaPlain.error && close(qCanadaPlain.perParcelCost, 8.98), `end-to-end quote for plain "Canada" (no postal code punctuation) should match the Canada (Major) rate, got ${JSON.stringify(qCanadaPlain)}`);
  // No postal code at all -> refuse rather than default to either.
  const zoneNoZip = taskG.resolveZone(standardDdp, { country: "Canada" });
  assert(!!zoneNoZip.error, `"Canada" with no postal code should refuse to guess Major vs. Rural, got ${JSON.stringify(zoneNoZip)}`);

  // Reported bug, other half: a domestic USPS-zoned Stord card given an
  // obviously non-US country should say so plainly, not ask for "a
  // 5-digit US ZIP" as if the input were merely malformed.
  const stordDomestic = defaults.US_STORD_ATL.find((c) => c.name === "Stord Economy");
  const domesticCanada = taskG.resolveZone(stordDomestic, { country: "Canada", zip: "T1J1Y6" });
  assert(!!domesticCanada.error && /isn't a US destination/.test(domesticCanada.error), `a domestic USPS card given a Canada destination should say so, not ask for a US ZIP, got ${JSON.stringify(domesticCanada)}`);
  // ...but a blank country (the normal way to enter a domestic US quote) must still work as before.
  const domesticBlankCountry = taskG.resolveZone(stordDomestic, { country: "", zip: "90001" });
  assert(!domesticBlankCountry.error && domesticBlankCountry.zone === "8", `a blank country + US ZIP should still resolve normally, got ${JSON.stringify(domesticBlankCountry)}`);
}

// ==================================================================
// Product catalog, order-based weight, shipment splitting, Stord's
// named-zone auto-detection, and multi-warehouse comparison — added
// 2026-09-17 per the user's request to calculate from ordered
// quantities instead of a hand-computed shipment weight.
// ==================================================================

// ---- defaultProductCatalog() / computeOrderWeights() ----
{
  const products = taskG.defaultProductCatalog();
  assert(products.length === 7, `default catalog should have the 7 seeded products, got ${products.length}`);
  const starterKit = products.find((p) => p.name === "Essential Starter Kit");
  assert(starterKit && close(starterKit.lengthCm, 31) && close(starterKit.widthCm, 15) && close(starterKit.heightCm, 27) && close(starterKit.weightKg, 1.8),
    `Essential Starter Kit dims/weight, got ${JSON.stringify(starterKit)}`);
  assert(products.every((p) => p.id && new Set(products.map((x) => x.id)).size === products.length), "every product should have a unique id");

  // 2x Essential Starter Kit (31x15x27cm, 1.8kg) + 10x Essential Trial
  // Pack (11x15x2.5cm, 0.1kg): actual = 2*1.8 + 10*0.1 = 4.6kg;
  // volume = 2*(31*15*27) + 10*(11*15*2.5) = 2*12555 + 10*412.5 = 29235cm³;
  // volumetric = 29235/5000 = 5.847kg > actual -> chargeable = volumetric.
  const trialPack = products.find((p) => p.name === "Essential Trial Pack (7ct)");
  const order = taskG.computeOrderWeights(products, { [starterKit.id]: 2, [trialPack.id]: 10 });
  assert(close(order.totalActualKg, 4.6), `total actual weight, got ${order.totalActualKg}`);
  assert(close(order.totalVolumeCm3, 29235), `total volume, got ${order.totalVolumeCm3}`);
  assert(close(order.volumetricKg, 5.847), `volumetric weight (cm3/5000), got ${order.volumetricKg}`);
  assert(close(order.chargeableKg, 5.847), `chargeable = greater of actual/volumetric, got ${order.chargeableKg}`);
  assert(order.lines.length === 2, `only the 2 ordered products should appear as lines, got ${order.lines.length}`);

  // Essential Refills (13x15x10.5cm, 0.5kg) is dense enough (0.5kg /
  // 2047.5cm³ ≈ 0.244 g/cm³, above the 0.2 g/cm³ break-even at a /5000
  // divisor) that actual weight should dominate over volumetric here.
  const refill = products.find((p) => p.name === "Essential Refills (30ct)");
  const heavyOnly = taskG.computeOrderWeights(products, { [refill.id]: 100 });
  assert(close(heavyOnly.totalActualKg, 50) && heavyOnly.chargeableKg === heavyOnly.totalActualKg && heavyOnly.chargeableKg > heavyOnly.volumetricKg,
    `actual weight should dominate for a dense order, got ${JSON.stringify(heavyOnly)}`);

  // Zero/absent quantities contribute nothing, and don't throw.
  const empty = taskG.computeOrderWeights(products, {});
  assert(empty.totalActualKg === 0 && empty.chargeableKg === 0, "an empty order should compute to zero, not NaN/throw");
}

// ---- resolveShipmentWeight(): catalog estimate vs. real carton override ----
{
  const products = taskG.defaultProductCatalog();
  const starterKit = products.find((p) => p.name === "Essential Starter Kit");

  // No override at all -> pure catalog estimate feeds totalWeightKg, no dims.
  const catalogOnly = taskG.resolveShipmentWeight({ products, quantities: { [starterKit.id]: 2 }, cartonOverride: {} });
  assert(catalogOnly.source === "catalog" && close(catalogOnly.totalWeightKg, catalogOnly.catalog.chargeableKg) && !catalogOnly.dims,
    `no override -> catalog estimate drives the weight, got ${JSON.stringify(catalogOnly)}`);

  // Real gross weight given (no dims) -> overrides the catalog weight
  // entirely, per carton, but no volumetric-vs-actual dims comparison.
  const weightOverride = taskG.resolveShipmentWeight({ products, quantities: { [starterKit.id]: 2 }, cartonOverride: { grossWeightKg: 4, cartons: 2 } });
  assert(weightOverride.source !== "catalog" && close(weightOverride.totalWeightKg, 8) && weightOverride.parcelCount === 2,
    `gross weight override (4kg x 2 cartons) should win over the catalog estimate, got ${JSON.stringify(weightOverride)}`);

  // Real outer-carton dims given -> passed through as dims for the
  // card's own dimDivisor-based volumetric calc downstream, catalog
  // weight still used as the "actual" baseline unless gross weight is
  // also given.
  const dimsOnly = taskG.resolveShipmentWeight({ products, quantities: { [starterKit.id]: 1 }, cartonOverride: { lengthCm: 40, widthCm: 30, heightCm: 20 } });
  assert(dimsOnly.dims && close(dimsOnly.dims.length, 40) && dimsOnly.dims.unit === "cm" && dimsOnly.source === "mixed",
    `real carton dims should be passed through as dims (unit cm), got ${JSON.stringify(dimsOnly)}`);

  // Both dims and gross weight given -> full override, one carton default.
  const fullOverride = taskG.resolveShipmentWeight({ products, quantities: {}, cartonOverride: { lengthCm: 50, widthCm: 40, heightCm: 30, grossWeightKg: 12 } });
  assert(fullOverride.source === "override" && close(fullOverride.totalWeightKg, 12) && fullOverride.parcelCount === 1 && fullOverride.dims,
    `full carton override, got ${JSON.stringify(fullOverride)}`);
}

// ---- cardRateTableMaxWeight() / proposeSplitConsignments() ----
{
  const card = taskG.emptyManualCard("US_STORD_ATL", "split test card", "kg", "cm");
  card.brackets = [{ min: 0, max: 20, prices: { All: 10 } }, { min: 20.01, max: 200, prices: { All: 50 } }];
  assert(taskG.cardRateTableMaxWeight(card) === 200, `should read the top bracket's max, got ${taskG.cardRateTableMaxWeight(card)}`);

  // The worked example from the spec: 200kg max, 300kg shipment -> [200, 100].
  const split = taskG.proposeSplitConsignments(300, 200);
  assert(split.length === 2 && close(split[0], 200) && close(split[1], 100), `300kg over a 200kg max, got ${JSON.stringify(split)}`);

  // An exact multiple of the max splits evenly with no tiny remainder consignment.
  const evenSplit = taskG.proposeSplitConsignments(400, 200);
  assert(evenSplit.length === 2 && close(evenSplit[0], 200) && close(evenSplit[1], 200), `400kg over a 200kg max (exact multiple), got ${JSON.stringify(evenSplit)}`);

  // Not actually over the max at all in the first place -> a trivial single-consignment "split".
  const noSplitNeeded = taskG.proposeSplitConsignments(150, 200);
  assert(noSplitNeeded.length === 1 && close(noSplitNeeded[0], 150), `under the max needs no real split, got ${JSON.stringify(noSplitNeeded)}`);

  // No usable max -> null, not a throw or an infinite loop.
  assert(taskG.proposeSplitConsignments(300, 0) === null, "a zero/missing max should return null, not loop forever");
  assert(taskG.proposeSplitConsignments(300, null) === null, "a null max should return null");
}

// ---- Split-shipment quoting end to end, including per-consignment surcharges ----
{
  const card = taskG.emptyManualCard("US_STORD_ATL", "split quote test card", "kg", "cm", "USD");
  card.brackets = [{ min: 0, max: 200, prices: { All: 100 } }];
  card.flatSurcharge = 5; // should apply PER CONSIGNMENT, not once overall
  card.splitAllowed = true;

  // 300kg over a 200kg max -> [200, 100], each still costs the flat 100
  // (the only bracket covers 0-200, so both the 200kg and 100kg
  // consignments price at the same flat 100) + 5 flat surcharge each.
  const q = taskG.quoteFreight({ card, totalWeightKg: 300, parcelCount: 1, dest: { zone: "All" } });
  assert(!q.error && !q.quoteRequired, `split quote should succeed, got ${JSON.stringify(q)}`);
  assert(Array.isArray(q.split) && q.split.length === 2, `should propose 2 consignments, got ${JSON.stringify(q.split)}`);
  assert(close(q.split[0].weight, 200) && close(q.split[0].cost, 105), `first consignment (200kg, +flat 5), got ${JSON.stringify(q.split[0])}`);
  assert(close(q.split[1].weight, 100) && close(q.split[1].cost, 105), `second consignment (100kg, +flat 5), got ${JSON.stringify(q.split[1])}`);
  assert(close(q.perParcelCost, 210) && close(q.totalCost, 210), `combined total = 105 + 105, got perParcelCost=${q.perParcelCost} totalCost=${q.totalCost}`);
  assert(q.packingConfirmationRequired === true, "a split-based quote must be labelled as needing packing confirmation");

  // splitAllowed: false on the same over-max shipment -> "quote required", not a guess.
  const cardNoSplit = { ...card, splitAllowed: false };
  const qNoSplit = taskG.quoteFreight({ card: cardNoSplit, totalWeightKg: 300, parcelCount: 1, dest: { zone: "All" } });
  assert(qNoSplit.quoteRequired === true, `splitting disabled should be quote-required, got ${JSON.stringify(qNoSplit)}`);

  // maxPhysicalWeight lower than the rate table's own max caps each
  // consignment further (e.g. a carrier's real per-parcel limit of 120kg,
  // even though the rate table itself lists brackets up to 200kg).
  const cardPhysicalCap = { ...card, maxPhysicalWeight: 120 };
  const qCapped = taskG.quoteFreight({ card: cardPhysicalCap, totalWeightKg: 300, parcelCount: 1, dest: { zone: "All" } });
  assert(qCapped.split.every((c) => c.weight <= 120 + 1e-6), `every consignment should respect the lower physical cap (120kg), got ${JSON.stringify(qCapped.split)}`);
}

// ---- resolveStordNamedZone(): Hawaii/Alaska/Puerto Rico/APO-FPO/territories by ZIP3 ----
{
  assert(taskG.resolveStordNamedZone("96815") === "Hawaii", "Honolulu HI (967-968) -> Hawaii");
  assert(taskG.resolveStordNamedZone("99501") === "Alaska", "Anchorage AK (995-999) -> Alaska");
  assert(taskG.resolveStordNamedZone("00901") === "Puerto Rico", "San Juan PR (006-009) -> Puerto Rico");
  assert(taskG.resolveStordNamedZone("34001") === "APO/FPO", "AA military ZIP (340) -> APO/FPO");
  assert(taskG.resolveStordNamedZone("09001") === "APO/FPO", "AE military ZIP (090-098) -> APO/FPO");
  assert(taskG.resolveStordNamedZone("96910") === "Other US Territories", "Guam (969) -> Other US Territories");
  assert(taskG.resolveStordNamedZone("30301") === null, "a plain continental US ZIP should fall through to the numbered USPS zone lookup");
  assert(taskG.resolveStordNamedZone("123") === null, "a too-short ZIP should return null, not throw");
}

// ---- Stord's real domestic cards: automatic USPS zone lookup + named-zone handling ----
{
  const defaults = taskG.defaultRateCards();
  const econ = defaults.US_STORD_ATL.find((c) => c.name === "Stord Economy");
  // Stord's own "Common Accessorials" tab documents a real per-lb
  // over-max overage rate (+$3.00/lb, min $50) uniformly across every
  // Stord service (domestic and international) — that supersedes the
  // fake-split-into-consignments behavior used before this was found.
  assert(econ.zoneSource === "usps" && econ.overageRatePerUnit === 3 && econ.overageMinCharge === 50, `Stord Economy should auto-detect zone and use the real over-max overage rate, got zoneSource=${econ.zoneSource} overageRatePerUnit=${econ.overageRatePerUnit} overageMinCharge=${econ.overageMinCharge}`);

  // A plain continental destination resolves automatically, no manual zone needed.
  const qAuto = taskG.quoteFreight({ card: econ, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zip: "90210" } });
  assert(!qAuto.error && qAuto.zone === "8" && qAuto.zoneAutoDetected === true && !qAuto.zoneManualOverride,
    `auto-detected zone for a continental ZIP, got ${JSON.stringify(qAuto)}`);

  // Hawaii resolves automatically too, since Economy has a plain "Hawaii" zone.
  const qHawaii = taskG.quoteFreight({ card: econ, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zip: "96815" } });
  assert(!qHawaii.error && qHawaii.zone === "Hawaii" && qHawaii.zoneAutoDetected === true, `Hawaii should auto-resolve on Economy, got ${JSON.stringify(qHawaii)}`);

  // Second Day only has Metro/Rural splits for Alaska/Hawaii — auto-detection
  // must refuse to guess between them rather than silently picking one.
  const secondDay = defaults.US_STORD_ATL.find((c) => c.name === "Stord Second Day");
  const qAmbiguous = taskG.quoteFreight({ card: secondDay, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zip: "96815" } });
  assert(!!qAmbiguous.error && /manually/i.test(qAmbiguous.error), `ambiguous Metro/Rural zone should refuse to guess, got ${JSON.stringify(qAmbiguous)}`);
  // ...but a manual zone override still works and is labelled as such.
  const qManual = taskG.quoteFreight({ card: secondDay, totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zip: "96815", zone: "Hawaii Metro" } });
  assert(!qManual.error && qManual.zone === "Hawaii Metro" && qManual.zoneManualOverride === true && !qManual.zoneAutoDetected,
    `manual override should be honored and labelled, got ${JSON.stringify(qManual)}`);

  // A real Stord card over its own max, end to end — priced via the
  // documented overage rate (top-bracket price + max(overWeight × $3,
  // $50)), not split into fake consignments: 300lb is 150lb over the
  // 150lb max, so overage = max(150 × 3, 50) = 450.
  const groundComm = defaults.US_STORD_ATL.find((c) => c.name === "Stord Ground Standard (Commercial)");
  const qOverage = taskG.quoteFreight({ card: groundComm, totalWeightKg: taskG.convertWeight(300, "lb", "kg"), parcelCount: 1, dest: { zip: "90210" } });
  assert(!qOverage.error && !qOverage.split && qOverage.overageApplied === true && close(qOverage.overageAmount, 450) && close(qOverage.totalCost, 546.38),
    `300lb over Ground Standard Commercial's 150lb max should price via the overage rate, not split, got ${JSON.stringify(qOverage)}`);

  // Below the $50 minimum threshold: 155lb is only 5lb over the 150lb
  // max (5 × 3 = 15 < 50), so the $50 minimum applies instead.
  const qOverageMin = taskG.quoteFreight({ card: groundComm, totalWeightKg: taskG.convertWeight(155, "lb", "kg"), parcelCount: 1, dest: { zip: "90210" } });
  assert(!qOverageMin.error && qOverageMin.overageApplied === true && close(qOverageMin.overageAmount, 50), `155lb (5lb over) should hit the $50 minimum overage, not 5×$3=$15, got ${JSON.stringify(qOverageMin)}`);
}

// ---- compareWarehouseQuotes(): cross-warehouse comparison, cheapest first ----
{
  const rateCards = taskG.defaultRateCards();
  const results = taskG.compareWarehouseQuotes({
    rateCards, warehouseIds: ["US_STORD_ATL", "US_STORD_RNO"],
    totalWeightKg: taskG.convertWeight(1, "lb", "kg"), parcelCount: 1, dest: { zip: "90210" },
  });
  assert(results.length > 0, "comparing Stord ATL + RNO should return results for every card on both");
  assert(results.some((r) => r.warehouseId === "US_STORD_ATL") && results.some((r) => r.warehouseId === "US_STORD_RNO"),
    "results should cover both requested warehouses");
  // Priced results should come first, sorted cheapest-first.
  const priced = results.filter((r) => typeof r.totalCost === "number");
  for (let i = 1; i < priced.length; i++) assert(priced[i].totalCost >= priced[i - 1].totalCost, "priced results should be sorted cheapest-first");
  // A card with no destination match for this route (e.g. an
  // international-only card given a domestic ZIP-only dest) should still
  // appear as an error/quote-required entry, not vanish from the list.
  const unresolved = results.filter((r) => typeof r.totalCost !== "number");
  assert(unresolved.every((r) => r.error || r.quoteRequired), "every non-priced result should carry an error or quoteRequired reason, not just disappear");
}

// ---- Bracket row perKg flag (synthetic card, isolated) ----
{
  const card = taskG.emptyManualCard("HK", "perKg test card", "kg", "cm");
  card.zones = ["Z1"];
  card.brackets = [
    { min: 0, max: 10, prices: { Z1: 50 } }, // normal flat bracket, unaffected by perKg support
    { min: 10.01, max: 99999, prices: { Z1: 4 }, perKg: true }, // rate-per-kg bracket
  ];
  const flat = taskG.priceForZone(card, "Z1", 5);
  assert(!flat.error && close(flat.price, 50), `flat bracket row should be unaffected by perKg support, got ${JSON.stringify(flat)}`);
  const perKg = taskG.priceForZone(card, "Z1", 20);
  assert(!perKg.error && close(perKg.price, 80), `perKg row should price as rate x weight (4 x 20 = 80), got ${JSON.stringify(perKg)}`);
  const perKgFraction = taskG.priceForZone(card, "Z1", 12.5);
  assert(!perKgFraction.error && close(perKgFraction.price, 50), `perKg row with a fractional weight (4 x 12.5 = 50), got ${JSON.stringify(perKgFraction)}`);
}

// ---- HK (OPS-WH01) real FedEx Export cards ----
{
  const defaults = taskG.defaultRateCards();
  assert(defaults.HK.length === 3, `defaultRateCards().HK should hold the 3 real FedEx cards, got ${defaults.HK.map((c) => c.name).join(", ")}`);
  const ipe = defaults.HK.find((c) => c.name.includes("IPE"));
  const ip = defaults.HK.find((c) => c.name.includes("IP (Priority)"));
  const ie = defaults.HK.find((c) => c.name.includes("IE (Economy)"));
  assert(!!ipe && !!ip && !!ie, `HK should have IPE, IP and IE cards, got ${defaults.HK.map((c) => c.name).join(", ")}`);

  // Spot checks manually verified against the source PDF (pdftotext -table
  // pages 4-6): IPE Package table.
  const r1 = taskG.priceForZone(ipe, "1", 3.0);
  assert(!r1.error && close(r1.price, 1081.2), `IPE zone 1 @ 3.0kg should be HKD 1,081.20, got ${JSON.stringify(r1)}`);
  const r2 = taskG.priceForZone(ipe, "J", 3.0);
  assert(!r2.error && close(r2.price, 514.08), `IPE zone J @ 3.0kg should be HKD 514.08, got ${JSON.stringify(r2)}`);
  const r3 = taskG.priceForZone(ipe, "U", 30);
  assert(!r3.error && close(r3.price, 4735.2), `IPE zone U per-kg band (21.0-44.0, 157.84/kg x 30kg) should be HKD 4,735.20, got ${JSON.stringify(r3)}`);
  // Top per-kg band (1,000.0 - 99,999.0): zone E is 144.80/kg (NOT zone 1,
  // which is 146.48/kg for that same row — see the discrepancy note in the
  // final report/commit message: the "zone 1 = 144.80/kg" spot check from
  // the task brief doesn't match the raw PDF text under the validated
  // column ordering, which 3 other spot checks (above) confirm is correct;
  // 144.80/kg is zone E's (and, in the K-T zone group table, zone K's) rate
  // on that row.
  const r4 = taskG.priceForZone(ipe, "E", 1500);
  assert(!r4.error && close(r4.price, 1500 * 144.8), `IPE zone E top per-kg band (144.80/kg x 1500kg), got ${JSON.stringify(r4)}`);

  // End-to-end via quoteFreight (manual zone override).
  const q1 = taskG.quoteFreight({ card: ipe, totalWeightKg: 3.0, parcelCount: 1, dest: { zone: "1" } });
  assert(!q1.error && close(q1.perParcelCost, 1081.2) && close(q1.totalCost, 1081.2), `quoteFreight IPE zone 1 @ 3kg, got ${JSON.stringify(q1)}`);

  // Country -> zone lookup, one per service (cross-checked against the raw
  // Export Zone Chart text, pp. 20-24).
  assert(taskG.findCountryZone(ipe.countryZoneMap, "Australia") === "U", `IPE Australia should map to zone U, got ${taskG.findCountryZone(ipe.countryZoneMap, "Australia")}`);
  assert(taskG.findCountryZone(ip.countryZoneMap, "Austria") === "M", `IP Austria should map to zone M, got ${taskG.findCountryZone(ip.countryZoneMap, "Austria")}`);
  assert(taskG.findCountryZone(ie.countryZoneMap, "Argentina") === "G", `IE Argentina should map to zone G, got ${taskG.findCountryZone(ie.countryZoneMap, "Argentina")}`);
  // A country IE doesn't serve (blank cell on the source rate sheet) must
  // be omitted from IE's map, not guessed — but IP/IPE do serve it.
  assert(taskG.findCountryZone(ie.countryZoneMap, "Democratic Republic of the Congo") === null, "IE should not have a zone for a country it doesn't serve");
  assert(taskG.findCountryZone(ip.countryZoneMap, "Democratic Republic of the Congo") === "H", "IP should map Democratic Republic of the Congo to zone H");

  // resolveZone() end to end via country, through the real card.
  const zoneResult = taskG.resolveZone(ie, { country: "australia" }); // case-insensitive
  assert(!zoneResult.error && zoneResult.zone === "U" && zoneResult.autoDetected === true, `resolveZone by country on the real IE card, got ${JSON.stringify(zoneResult)}`);

  // Every card should use FedEx's own volumetric divisor and be marked as
  // effectively unlimited (no splitting needed).
  for (const c of [ipe, ip, ie]) {
    assert(c.dimDivisor === 5000, `${c.name} should use dimDivisor 5000, got ${c.dimDivisor}`);
    assert(c.splitAllowed === false, `${c.name} should have splitAllowed false, got ${c.splitAllowed}`);
    assert(c.currency === "HKD" && c.mode === "bracket" && c.zoneSource === "manual", `${c.name} basic card shape, got currency=${c.currency} mode=${c.mode} zoneSource=${c.zoneSource}`);
  }
}

// ---- GPS: DDP/DDU country-name typo fix + USPS auto-zone (origin 085) ----
// The source rate sheet's own "Destinations" header row misspelled two
// countries ("Noway", "Saudi Arabic") — since a card's zones/
// countryZoneMap are built directly from those header names, the typo
// silently broke auto-detection for a user typing the correct spelling.
{
  const ddp = taskG.gpsDdpCard();
  assert(ddp.zones.includes("Norway") && !ddp.zones.includes("Noway"), `DDP zones should have "Norway", not "Noway", got ${JSON.stringify(ddp.zones)}`);
  assert(ddp.zones.includes("Saudi Arabia") && !ddp.zones.includes("Saudi Arabic"), `DDP zones should have "Saudi Arabia", not "Saudi Arabic", got ${JSON.stringify(ddp.zones)}`);
  const norwayResult = taskG.resolveZone(ddp, { country: "Norway" });
  assert(!norwayResult.error && norwayResult.zone === "Norway" && norwayResult.autoDetected === true, `resolveZone("Norway") on the real DDP card, got ${JSON.stringify(norwayResult)}`);
  const saudiResult = taskG.resolveZone(ddp, { country: "saudi arabia" }); // case-insensitive
  assert(!saudiResult.error && saudiResult.zone === "Saudi Arabia" && saudiResult.autoDetected === true, `resolveZone("saudi arabia") on the real DDP card, got ${JSON.stringify(saudiResult)}`);
}

// GPS's own USPS-branded domestic cards (Ground Advantage, Priority Mail)
// now auto-detect zone by ZIP the same way Stord's cards do, using a real
// USPS zone chart fetched for GPS's own origin ZIP3 "085" (Jackson
// Township, NJ). UPS Ground / FedEx Ground / FedEx Ground Economy
// deliberately stay zoneSource: "manual" — those carriers publish their
// own zone-by-ZIP3 charts, which aren't guaranteed to match USPS's chart
// zip3-for-zip3, and no such chart has been fetched/verified for them.
{
  const ga = taskG.gpsUspsGaCard();
  const pm = taskG.gpsUspsPmCard();
  assert(ga.zoneSource === "usps", `GPS USPS Ground Advantage should auto-detect zone, got zoneSource=${ga.zoneSource}`);
  assert(pm.zoneSource === "usps", `GPS USPS Priority Mail should auto-detect zone, got zoneSource=${pm.zoneSource}`);
  for (const manualCard of [taskG.gpsUpsGroundCard(), taskG.gpsFedexGroundCard(), taskG.gpsFedexGroundEconomyCard()]) {
    assert(manualCard.zoneSource === "manual", `${manualCard.name} should stay manual (no verified carrier-specific zone chart), got ${manualCard.zoneSource}`);
  }

  const wh = taskG.getWarehouse("US_GPS");
  assert(wh.uspsOriginZip3 === "085", `US_GPS warehouse should have uspsOriginZip3 "085", got ${wh.uspsOriginZip3}`);

  // Spot-checked against postcalc.usps.com/domesticzonechart for origin 085.
  const laResult = taskG.resolveZone(ga, { zip: "90001" }); // Los Angeles
  assert(!laResult.error && laResult.zone === "8" && laResult.autoDetected === true, `resolveZone by ZIP (LA) on the real GPS USPS-GA card, got ${JSON.stringify(laResult)}`);
  const newarkResult = taskG.resolveZone(ga, { zip: "07102" }); // Newark, NJ — near the origin
  assert(!newarkResult.error && newarkResult.zone === "1" && newarkResult.autoDetected === true, `resolveZone by ZIP (Newark) on the real GPS USPS-GA card, got ${JSON.stringify(newarkResult)}`);

  // Hawaii/Alaska/PR/APO ZIPs still safely refuse rather than guess, since
  // these GPS cards (unlike some Stord cards) don't carry a named zone
  // for them at all.
  const hiResult = taskG.resolveZone(ga, { zip: "96814" }); // Honolulu
  assert(!!hiResult.error, `resolveZone by ZIP (Honolulu) should refuse rather than guess, got ${JSON.stringify(hiResult)}`);

  // Full end-to-end quote, no manual zone entry required.
  const quote = taskG.quoteFreight({ card: ga, totalWeightKg: 2, parcelCount: 1, dims: null, dest: { zip: "90001" } });
  assert(!quote.error && !quote.quoteRequired && quote.zoneAutoDetected === true && quote.zone === "8", `end-to-end GPS USPS-GA quote by ZIP alone, got ${JSON.stringify(quote)}`);

  // Splitting: the source sheet's priced bracket ladder tops out at
  // 20lb, but the card's own notes state a real 70lb physical max for
  // both GA and PM — so a heavier shipment should split into
  // consignments instead of refusing outright (reported: a 55.36lb
  // shipment to LA/zone 8 previously errored "exceeds this card's
  // maximum of 20 lb... splitting isn't enabled").
  assert(ga.splitAllowed === true && ga.maxPhysicalWeight === 70, `GPS USPS-GA should allow splitting up to its real 70lb physical max, got splitAllowed=${ga.splitAllowed} maxPhysicalWeight=${ga.maxPhysicalWeight}`);
  assert(pm.splitAllowed === true && pm.maxPhysicalWeight === 70, `GPS USPS-PM should allow splitting up to its real 70lb physical max, got splitAllowed=${pm.splitAllowed} maxPhysicalWeight=${pm.maxPhysicalWeight}`);
  const heavyKg = taskG.convertWeight(55.36, "lb", "kg");
  const heavyQuote = taskG.quoteFreight({ card: ga, totalWeightKg: heavyKg, parcelCount: 1, dims: null, dest: { zip: "90001" } });
  assert(!heavyQuote.error && !heavyQuote.quoteRequired, `55.36lb GPS USPS-GA to zone 8 should split rather than error, got ${JSON.stringify(heavyQuote)}`);
  assert(Array.isArray(heavyQuote.split) && heavyQuote.split.length === 3, `55.36lb over a 20lb ladder should split into 3 consignments (20+20+15.36), got ${JSON.stringify(heavyQuote.split)}`);
  assert(close(heavyQuote.split[0].weight, 20) && close(heavyQuote.split[1].weight, 20) && close(heavyQuote.split[2].weight, 15.36, 1e-6), `split consignment weights, got ${JSON.stringify(heavyQuote.split.map((s) => s.weight))}`);
  assert(heavyQuote.packingConfirmationRequired === true, "a split quote should be flagged as needing packing confirmation");
  assert(close(heavyQuote.totalCost, 82.81, 0.01), `55.36lb GPS USPS-GA to zone 8 total, got ${heavyQuote.totalCost}`);
}

if (!ok) {
  console.error("\nTASK G TEST FAILED");
  process.exit(1);
}
console.log("TASK G TEST PASSED");

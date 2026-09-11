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

  // Weight beyond every bracket -> error, not a silent 0/NaN.
  const qOver = taskG.quoteFreight({ card, totalWeightKg: 100, parcelCount: 1, dest: { country: "Germany" } });
  assert(!!qOver.error, `weight beyond all brackets should error, got ${JSON.stringify(qOver)}`);

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

// ---- Real UK (OPS-WH02) rate cards seeded from the Royal Mail / DPD rate
// card (RS UK eFulfillment Rate_VIP4.1_IM8_2026.4.1.xlsx, 2026-09-11) ----
{
  const rm = taskG.ukRoyalMailCard();
  // 1.5kg to a mainland (Area 1) address: base 2.30 + flat surcharge 0.17.
  const qLocal = taskG.quoteFreight({ card: rm, totalWeightKg: 1.5, parcelCount: 1, dest: { zone: "Area 1" } });
  assert(!qLocal.error && close(qLocal.perParcelCost, 2.47), `Royal Mail Area 1 0-2kg, got ${JSON.stringify(qLocal)}`);
  // 3kg to Area 3 (remote-area surcharge already folded into the bracket price): 7.10 + 0.17.
  const qRemote = taskG.quoteFreight({ card: rm, totalWeightKg: 3, parcelCount: 1, dest: { zone: "Area 3" } });
  assert(!qRemote.error && close(qRemote.perParcelCost, 7.27), `Royal Mail Area 3 2.01-5kg, got ${JSON.stringify(qRemote)}`);

  const dpdUk = taskG.ukDpdUkCard();
  // Northern Ireland (Zone 4) price already includes the NI Clearance Surcharge.
  const qNi = taskG.quoteFreight({ card: dpdUk, totalWeightKg: 5, parcelCount: 1, dest: { zone: "Zone 4" } });
  assert(!qNi.error && close(qNi.perParcelCost, 13.6), `DPD UK Zone 4 (Northern Ireland), got ${JSON.stringify(qNi)}`);

  const dpdIntl = taskG.ukDpdNonUkCard();
  // Country -> zone resolution should work directly off the country name (identity map).
  const qNorway = taskG.quoteFreight({ card: dpdIntl, totalWeightKg: 1, parcelCount: 1, dest: { country: "Norway" } });
  assert(!qNorway.error && close(qNorway.perParcelCost, 29.5), `DPD Non-UK Norway 0.51-1kg, got ${JSON.stringify(qNorway)}`);
}

if (!ok) {
  console.error("\nTASK G TEST FAILED");
  process.exit(1);
}
console.log("TASK G TEST PASSED");

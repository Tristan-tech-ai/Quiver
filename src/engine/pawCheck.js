// PawCheck — one call: "can my dog/cat eat X?" a deterministic safety verdict from a curated
// toxicity table (vet/ASPCA-grounded). Non-crypto utility; mirrors the food-scanner shape that
// sold 539 on the marketplace. Recurring: pet-owner assistant agents field this constantly.
import { config } from '../config.js';

// Curated toxicity table. severity: toxic (never) / caution (amount/prep dependent) / safe.
// Keyed by canonical food; synonyms map into it. Grounded in ASPCA/vet consensus.
const DB = {
  chocolate: { dog: 'toxic', cat: 'toxic', why: 'Theobromine and caffeine are toxic; dark/baking chocolate is worst. Can cause vomiting, tremors, seizures, cardiac issues.', act: 'Call a vet / pet poison line immediately with the amount and type.' },
  xylitol: { dog: 'toxic', cat: 'caution', why: 'Xylitol (in sugar-free gum, some peanut butters, baked goods) causes rapid insulin release and liver failure in dogs.', act: 'Emergency vet immediately for dogs — even small amounts are dangerous.' },
  grape: { dog: 'toxic', cat: 'caution', why: 'Grapes and raisins can cause acute kidney failure in dogs; mechanism unknown so no safe dose.', act: 'Contact a vet even for a small amount.' },
  raisin: { alias: 'grape' },
  onion: { dog: 'toxic', cat: 'toxic', why: 'Onions, garlic, leeks, chives (Allium) damage red blood cells causing anemia; cats are especially sensitive.', act: 'Vet if more than a trace was eaten.' },
  garlic: { alias: 'onion' },
  macadamia: { dog: 'toxic', cat: 'caution', why: 'Macadamia nuts cause weakness, tremors, hyperthermia in dogs.', act: 'Vet if a significant amount was eaten.' },
  avocado: { dog: 'caution', cat: 'caution', why: 'Persin and the pit are the concern; flesh is low-risk in small amounts but pit is a choking/obstruction hazard.', act: 'Avoid the pit and skin; small flesh amounts usually fine.' },
  alcohol: { dog: 'toxic', cat: 'toxic', why: 'Ethanol is highly toxic to pets even in small amounts.', act: 'Emergency vet.' },
  caffeine: { dog: 'toxic', cat: 'toxic', why: 'Coffee, tea, energy drinks — methylxanthines cause the same effects as chocolate.', act: 'Emergency vet.' },
  coffee: { alias: 'caffeine' },
  chicken: { dog: 'safe', cat: 'safe', why: 'Plain cooked boneless chicken is a safe protein. Avoid cooked bones (splinter) and heavy seasoning.', act: 'Serve plain, cooked, boneless, unseasoned.' },
  carrot: { dog: 'safe', cat: 'safe', why: 'Plain carrots are safe and a low-calorie treat; cut to avoid choking.', act: 'Serve raw or cooked, cut into safe pieces.' },
  apple: { dog: 'safe', cat: 'caution', why: 'Apple flesh is safe; seeds contain cyanide compounds so core/seeds should be removed.', act: 'Remove core and seeds; serve flesh in moderation.' },
  peanutbutter: { dog: 'caution', cat: 'caution', why: 'Plain peanut butter is fine, BUT check for xylitol which is deadly to dogs.', act: 'Only feed if xylitol-free; check the label.' },
  cheese: { dog: 'caution', cat: 'caution', why: 'Small amounts are usually OK but many pets are lactose intolerant; high fat can trigger issues.', act: 'Small amounts only; watch for GI upset.' },
  milk: { dog: 'caution', cat: 'caution', why: 'Most adult pets are lactose intolerant; can cause diarrhea.', act: 'Avoid or give only tiny amounts.' },
  bread: { dog: 'caution', cat: 'caution', why: 'Plain baked bread in small amounts is low-risk; raw yeast dough is dangerous (expands, produces alcohol).', act: 'Never feed raw dough; plain baked bread sparingly.' },
  salmon: { dog: 'safe', cat: 'safe', why: 'Cooked, boneless salmon is safe and healthy; never feed raw (parasite risk).', act: 'Cook fully, remove bones.' },
  banana: { dog: 'safe', cat: 'caution', why: 'Bananas are safe in small amounts as an occasional treat (high sugar).', act: 'Small pieces occasionally.' },
};

const SYN = { choc: 'chocolate', 'dark chocolate': 'chocolate', cocoa: 'chocolate', grapes: 'grape', raisins: 'raisin', onions: 'onion', garlics: 'garlic', 'macadamia nut': 'macadamia', 'macadamia nuts': 'macadamia', booze: 'alcohol', beer: 'alcohol', wine: 'alcohol', espresso: 'coffee', 'peanut butter': 'peanutbutter', pb: 'peanutbutter', apples: 'apple', carrots: 'carrot', bananas: 'banana' };

function resolve(key) {
  let k = String(key || '').toLowerCase().trim().replace(/[^a-z ]/g, '');
  if (SYN[k]) k = SYN[k];
  k = k.replace(/\s+/g, '');
  let rec = DB[k];
  let guard = 0;
  while (rec && rec.alias && guard++ < 5) { k = rec.alias; rec = DB[k]; }
  return rec ? { key: k, rec } : null;
}

export function pawCheck({ food, species = 'dog' }) {
  const sp = ['dog', 'cat'].includes(String(species).toLowerCase()) ? String(species).toLowerCase() : 'dog';
  const hit = resolve(food);
  if (!hit) {
    return {
      service: 'paw-check', version: config.version, food, species: sp,
      verdict: 'UNKNOWN', safe: null,
      note: `"${food}" is not in the curated safety table. When a food is not known-safe, do not feed it and check with a veterinarian.`,
      disclaimer: 'Informational only, grounded in general ASPCA/veterinary guidance — not a substitute for professional veterinary advice. In an emergency contact a vet or a pet poison hotline.',
    };
  }
  const level = hit.rec[sp];
  const verdict = level === 'toxic' ? 'DO_NOT_FEED' : level === 'caution' ? 'CAUTION' : 'SAFE';
  return {
    service: 'paw-check', version: config.version,
    food: hit.key, species: sp,
    verdict, safe: level === 'safe',
    severity: level,
    why: hit.rec.why,
    whatToDo: hit.rec.act,
    disclaimer: 'Informational only, grounded in general ASPCA/veterinary guidance — not a substitute for professional veterinary advice. In an emergency contact a vet or a pet poison hotline.',
  };
}

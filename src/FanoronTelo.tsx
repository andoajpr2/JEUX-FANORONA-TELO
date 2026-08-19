/* ============================================================================
 * FANORON-TELO — jeu de plateau traditionnel malgache (variante à 3 pions)
 * ----------------------------------------------------------------------------
 * Plateau : 9 intersections (0 à 8) en grille 3×3. Sont tracées les 3 lignes,
 * les 3 colonnes et les 2 grandes diagonales — le centre (4) touche les 8 autres.
 *
 * Règles :
 *  1. Phase de pose    — chacun place à tour de rôle ses 3 vato.
 *  2. Phase de déplacement — un vato glisse vers un point VIDE et ADJACENT.
 *  3. Victoire         — aligner ses 3 vato sur l'une des 8 lignes.
 *  4. Blocage          — celui qui ne peut pas jouer perd.
 *  5. Nulle (fatrana)  — même position 3 fois, ou 50 coups sans victoire.
 *
 * Organisation du fichier : logique pure d'abord (fonctions sans effet de
 * bord), puis le composant React (état, effets, rendu SVG).
 * ==========================================================================*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/* ----------------------------- Types ------------------------------------ */

type Joueur = 1 | 2; // 1 = Mena (rouge), 2 = Mainty (noir)
type Phase = "pose" | "deplacement";
type Mode = "duo" | "ia";
type Niveau = "facile" | "moyen" | "difficile";

interface Coup {
  type: "pose" | "deplace";
  de: number; // -1 pour une pose
  vers: number;
}

interface Etat {
  plateau: number[]; // 9 cases : 0 = vide, 1 = Mena, 2 = Mainty
  trait: Joueur; // joueur au trait
  poses: [number, number]; // vato déjà posés par joueur
  phase: Phase;
  vainqueur: Joueur | 0;
  nulle: string | null; // motif de nullité, sinon null
  nbCoups: number; // demi-coups joués
  positions: string[]; // clés des positions traversées (répétition ×3)
}

interface Entree {
  etat: Etat;
  coup: Coup | null; // coup ayant mené à cet état (null pour l'état initial)
}

interface Statut {
  terminee: boolean;
  vainqueur: Joueur | 0;
  nulle: boolean;
  raison: string | null;
  ligne: [number, number, number] | null; // alignement gagnant, le cas échéant
  coups: Coup[]; // coups légaux du joueur au trait
}

interface Piece {
  id: string;
  joueur: Joueur;
  pos: number;
}

/* ------------------------- Géométrie du plateau -------------------------- */

// Liste d'adjacence EXACTE du fanoron-telo (le centre est relié à tout).
const ADJACENCES: readonly (readonly number[])[] = [
  [1, 3, 4],
  [0, 2, 4],
  [1, 4, 5],
  [0, 4, 6],
  [0, 1, 2, 3, 5, 6, 7, 8],
  [2, 4, 8],
  [3, 4, 7],
  [4, 6, 8],
  [4, 5, 7],
];

const ALIGNEMENTS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

// Coordonnées SVG des 9 intersections (viewBox 0 0 300 300).
const COORDS: readonly (readonly [number, number])[] = [
  [50, 50],
  [150, 50],
  [250, 50],
  [50, 150],
  [150, 150],
  [250, 150],
  [50, 250],
  [150, 250],
  [250, 250],
];

// Notation des cases pour le journal : colonnes A–C, rangées 1–3.
const NOMS_CASES = ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"];

const NOMS_JOUEURS: Record<Joueur, string> = { 1: "Mena", 2: "Mainty" };

/* ==================== LOGIQUE PURE DU JEU ================================ */

const adversaire = (j: Joueur): Joueur => (j === 1 ? 2 : 1);

/** Clé unique d'une position : plateau + joueur au trait. */
function clePosition(etat: Etat): string {
  return `${etat.plateau.join("")}|${etat.trait}`;
}

function etatInitial(): Etat {
  const etat: Etat = {
    plateau: Array(9).fill(0),
    trait: 1, // Mena commence toujours
    poses: [0, 0],
    phase: "pose",
    vainqueur: 0,
    nulle: null,
    nbCoups: 0,
    positions: [],
  };
  etat.positions = [clePosition(etat)];
  return etat;
}

/** Renvoie le vainqueur (1 ou 2) si un alignement est complet, sinon 0. */
function checkWinner(plateau: number[]): Joueur | 0 {
  for (const [a, b, c] of ALIGNEMENTS) {
    const v = plateau[a];
    if (v !== 0 && v === plateau[b] && v === plateau[c]) return v as Joueur;
  }
  return 0;
}

/** Retrouve l'alignement gagnant d'un joueur (pour le tracé final). */
function trouverLigne(plateau: number[], joueur: Joueur): [number, number, number] | null {
  for (const [a, b, c] of ALIGNEMENTS) {
    if (plateau[a] === joueur && plateau[b] === joueur && plateau[c] === joueur) return [a, b, c];
  }
  return null;
}

/** Tous les coups légaux du joueur au trait. */
function getLegalMoves(etat: Etat): Coup[] {
  if (etat.vainqueur || etat.nulle) return [];
  const coups: Coup[] = [];
  if (etat.phase === "pose") {
    // Pose : toute intersection libre.
    for (let i = 0; i < 9; i++) if (etat.plateau[i] === 0) coups.push({ type: "pose", de: -1, vers: i });
  } else {
    // Déplacement : vers un point vide et adjacent (pas de saut, pas de prise).
    for (let i = 0; i < 9; i++) {
      if (etat.plateau[i] !== etat.trait) continue;
      for (const j of ADJACENCES[i]) if (etat.plateau[j] === 0) coups.push({ type: "deplace", de: i, vers: j });
    }
  }
  return coups;
}

/** Applique un coup et renvoie le nouvel état (immuable). */
function applyMove(etat: Etat, coup: Coup): Etat {
  const plateau = etat.plateau.slice();
  let poses: [number, number] = [etat.poses[0], etat.poses[1]];
  let phase: Phase = etat.phase;

  if (coup.type === "pose") {
    plateau[coup.vers] = etat.trait;
    poses = etat.trait === 1 ? [poses[0] + 1, poses[1]] : [poses[0], poses[1] + 1];
    if (poses[0] + poses[1] === 6) phase = "deplacement";
  } else {
    plateau[coup.de] = 0;
    plateau[coup.vers] = etat.trait;
  }

  const vainqueur = checkWinner(plateau);
  const nbCoups = etat.nbCoups + 1;
  const suivant: Etat = {
    plateau,
    trait: adversaire(etat.trait),
    poses,
    phase,
    vainqueur,
    nulle: null,
    nbCoups,
    positions: etat.positions,
  };

  // Détection de nullité : triple répétition ou 50 coups sans victoire.
  const cle = clePosition(suivant);
  const positions = [...etat.positions, cle];
  let nulle: string | null = null;
  if (!vainqueur) {
    let repetitions = 0;
    for (const p of positions) if (p === cle) repetitions++;
    if (repetitions >= 3) nulle = "Triple répétition de la même position";
    else if (nbCoups >= 50) nulle = "50 coups joués sans victoire";
  }
  return { ...suivant, positions, nulle };
}

/** Statut complet de la partie : fin, vainqueur, nulle, blocage, coups légaux. */
function getStatut(etat: Etat): Statut {
  if (etat.vainqueur) {
    return {
      terminee: true,
      vainqueur: etat.vainqueur,
      nulle: false,
      raison: null,
      ligne: trouverLigne(etat.plateau, etat.vainqueur),
      coups: [],
    };
  }
  if (etat.nulle) {
    return { terminee: true, vainqueur: 0, nulle: true, raison: etat.nulle, ligne: null, coups: [] };
  }
  const coups = getLegalMoves(etat);
  if (coups.length === 0) {
    // Règle 5 : celui qui est au trait sans aucun coup légal perd la partie.
    return {
      terminee: true,
      vainqueur: adversaire(etat.trait),
      nulle: false,
      raison: `${NOMS_JOUEURS[etat.trait]} est bloqué — aucun coup légal (tsy misy lalana)`,
      ligne: null,
      coups: [],
    };
  }
  return { terminee: false, vainqueur: 0, nulle: false, raison: null, ligne: null, coups };
}

/* ------------------------ IA : minimax α-β ------------------------------- */

const SCORE_VICTOIRE = 100000;
const PROFONDEURS: Record<Exclude<Niveau, "facile">, number> = { moyen: 3, difficile: 7 };

/**
 * Évaluation heuristique, du point de vue du joueur AU TRAIT.
 * Menaces (2 vato + case vide) fortement pondérées, centre valorisé.
 */
function evaluate(etat: Etat): number {
  const moi = etat.trait;
  const toi = adversaire(moi);
  let score = 0;
  for (const [a, b, c] of ALIGNEMENTS) {
    const va = etat.plateau[a];
    const vb = etat.plateau[b];
    const vc = etat.plateau[c];
    const nMoi = (va === moi ? 1 : 0) + (vb === moi ? 1 : 0) + (vc === moi ? 1 : 0);
    const nToi = (va === toi ? 1 : 0) + (vb === toi ? 1 : 0) + (vc === toi ? 1 : 0);
    if (nToi === 0 && nMoi > 0) score += nMoi === 2 ? 32 : 5;
    else if (nMoi === 0 && nToi > 0) score -= nToi === 2 ? 32 : 5;
  }
  if (etat.plateau[4] === moi) score += 7;
  else if (etat.plateau[4] === toi) score -= 7;
  return score;
}

/** Note servant à trier les coups enfants (les plus prometteurs d'abord). */
function noteOrdre(enfant: Etat): number {
  if (enfant.vainqueur) return SCORE_VICTOIRE * 10; // coup gagnant immédiat
  if (enfant.nulle) return -10;
  return -evaluate(enfant); // evaluate est vu de l'adversaire après le coup
}

/**
 * Negamax avec élagage alpha-bêta.
 * `chemin` contient les clés des positions de la ligne actuelle : si une
 * position s'y répète, la ligne est jugée nulle (0) — détection de cycles
 * qui évite les boucles et décourage les répétitions stériles.
 * Le score est ajusté par le pli : victoire rapide préférée, défaite repoussée.
 */
function negamax(
  etat: Etat,
  profondeur: number,
  alpha: number,
  beta: number,
  chemin: Map<string, number>,
  pli: number
): number {
  if (etat.vainqueur) return -(SCORE_VICTOIRE - pli); // le camp au trait vient de perdre
  if (etat.nulle) return 0;

  const cle = clePosition(etat);
  if (chemin.has(cle)) return 0; // cycle dans cette ligne

  const coups = getLegalMoves(etat);
  if (coups.length === 0) return -(SCORE_VICTOIRE - pli); // bloqué : perdu

  if (profondeur === 0) return evaluate(etat);

  chemin.set(cle, 1);
  const enfants: Etat[] = [];
  for (const c of coups) enfants.push(applyMove(etat, c));
  enfants.sort((a, b) => noteOrdre(b) - noteOrdre(a));

  let meilleur = -Infinity;
  for (const enfant of enfants) {
    const s = -negamax(enfant, profondeur - 1, -beta, -alpha, chemin, pli + 1);
    if (s > meilleur) meilleur = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break; // coupe
  }
  chemin.delete(cle);
  return meilleur;
}

/** Choisit le coup de l'ordinateur selon le niveau demandé. */
function meilleurCoupIA(etat: Etat, niveau: Niveau): Coup | null {
  const coups = getLegalMoves(etat);
  if (coups.length === 0) return null;

  if (niveau === "facile") {
    // Prend un coup gagnant s'il existe, sinon joue au hasard.
    for (const c of coups) {
      if (applyMove(etat, c).vainqueur === etat.trait) return c;
    }
    return coups[Math.floor(Math.random() * coups.length)];
  }

  const profondeur = PROFONDEURS[niveau];
  const chemin = new Map<string, number>();
  chemin.set(clePosition(etat), 1);

  // Mélange préalable : à score égal, l'IA varie ses parties.
  const melange = coups.slice();
  for (let i = melange.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = melange[i];
    melange[i] = melange[j];
    melange[j] = tmp;
  }
  const enfants = melange.map((coup) => ({ coup, etat: applyMove(etat, coup) }));
  enfants.sort((a, b) => noteOrdre(b.etat) - noteOrdre(a.etat));

  let alpha = -Infinity;
  let choix: Coup = enfants[0].coup;
  for (const en of enfants) {
    const s = -negamax(en.etat, profondeur - 1, -Infinity, -alpha, chemin, 1);
    if (s > alpha) {
      alpha = s;
      choix = en.coup;
    }
  }
  return choix;
}

/* ------------------- Pièces animées (rejeu de l'historique) --------------- */

/**
 * Reconstruit la liste des pièces avec des identifiants stables en rejouant
 * l'historique — indispensable pour animer les déplacements en CSS.
 */
function rejouerPieces(historique: Entree[]): Piece[] {
  const pieces: Piece[] = [];
  for (let k = 1; k < historique.length; k++) {
    const joueur = historique[k - 1].etat.trait;
    const coup = historique[k].coup;
    if (!coup) continue;
    if (coup.type === "pose") {
      const n = pieces.filter((p) => p.joueur === joueur).length + 1;
      pieces.push({ id: `${joueur}-${n}`, joueur, pos: coup.vers });
    } else {
      const piece = pieces.find((p) => p.pos === coup.de);
      if (piece) piece.pos = coup.vers;
    }
  }
  return pieces;
}

/* ------------------------- Petit son (WebAudio) --------------------------- */

let ctxAudio: AudioContext | null = null;

/** « Toc » de bois à chaque coup, petite tierce en fin de partie. */
function jouerSon(type: "toc" | "fin"): void {
  try {
    const w = window as Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    ctxAudio = ctxAudio ?? new Ctor();
    if (ctxAudio.state === "suspended") void ctxAudio.resume();
    const t0 = ctxAudio.currentTime;
    const notes = type === "toc" ? [196] : [392, 523.25];
    notes.forEach((f, i) => {
      const osc = ctxAudio!.createOscillator();
      const gain = ctxAudio!.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      const t = t0 + i * 0.1;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(gain);
      gain.connect(ctxAudio!.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    });
  } catch {
    /* audio indisponible : on ignore silencieusement */
  }
}

/* ============================ COMPOSANT =================================== */

export default function FanoronTelo() {
  const [historique, setHistorique] = useState<Entree[]>(() => [{ etat: etatInitial(), coup: null }]);
  const [mode, setMode] = useState<Mode>("duo");
  const [niveau, setNiveau] = useState<Niveau>("moyen");
  const [selection, setSelection] = useState<number | null>(null);
  const [survol, setSurvol] = useState<number | null>(null);
  const journalRef = useRef<HTMLOListElement | null>(null);

  const etat = historique[historique.length - 1].etat;
  const statut = useMemo(() => getStatut(etat), [etat]);
  const pieces = useMemo(() => rejouerPieces(historique), [historique]);
  const dernierCoup = historique[historique.length - 1].coup;
  const tourIA = mode === "ia" && etat.trait === 2 && !statut.terminee;
  const humainBloque = tourIA || statut.terminee;

  // Occurrences de la position courante (pour afficher la menace de fatrana).
  const repetitions = useMemo(() => {
    const cle = clePosition(etat);
    return etat.positions.reduce((n, p) => (p === cle ? n + 1 : n), 0);
  }, [etat]);

  const jouerCoup = useCallback((coup: Coup) => {
    setHistorique((h) => {
      const courant = h[h.length - 1].etat;
      if (courant.vainqueur || courant.nulle) return h;
      const valide = getLegalMoves(courant).some(
        (c) => c.type === coup.type && c.de === coup.de && c.vers === coup.vers
      );
      if (!valide) return h;
      return [...h, { etat: applyMove(courant, coup), coup }];
    });
    setSelection(null);
    jouerSon("toc");
  }, []);

  // L'ordinateur joue avec un léger temps de « réflexion ».
  useEffect(() => {
    if (mode !== "ia" || statut.terminee || etat.trait !== 2) return;
    const timer = setTimeout(() => {
      const coup = meilleurCoupIA(etat, niveau);
      if (coup) jouerCoup(coup);
    }, 620);
    return () => clearTimeout(timer);
  }, [historique, mode, niveau, etat, statut.terminee, jouerCoup]);

  // Petite tierce quand la partie se termine.
  useEffect(() => {
    if (statut.terminee) jouerSon("fin");
  }, [statut.terminee]);

  // Le journal suit automatiquement le dernier coup.
  useEffect(() => {
    const el = journalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historique.length]);

  /* ------------------------- Actions de l'interface ----------------------- */

  const nouvellePartie = () => {
    setHistorique([{ etat: etatInitial(), coup: null }]);
    setSelection(null);
    setSurvol(null);
  };

  const annulerCoup = () => {
    setSelection(null);
    setHistorique((h) => {
      if (h.length <= 1) return h;
      let nh = h.slice(0, -1);
      // Contre l'ordinateur, on annule aussi sa riposte pour rendre la main.
      if (mode === "ia" && nh.length > 1 && nh[nh.length - 1].etat.trait === 2) nh = nh.slice(0, -1);
      return nh;
    });
  };

  const changerMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    nouvellePartie();
  };

  const surClicCase = (i: number) => {
    if (humainBloque) return;
    if (etat.phase === "pose") {
      if (etat.plateau[i] === 0) jouerCoup({ type: "pose", de: -1, vers: i });
      return;
    }
    if (selection === i) {
      setSelection(null); // re-cliquer sur le vato choisi annule
      return;
    }
    if (etat.plateau[i] === etat.trait) {
      setSelection(i); // choisir (ou re-choisir) un de ses vato
      return;
    }
    if (selection !== null && etat.plateau[i] === 0 && ADJACENCES[selection].includes(i)) {
      jouerCoup({ type: "deplace", de: selection, vers: i });
    }
  };

  /* ------------------------------ Dérivés UI ------------------------------ */

  const destinations = useMemo(
    () => (selection !== null ? statut.coups.filter((c) => c.de === selection).map((c) => c.vers) : []),
    [selection, statut.coups]
  );

  const journal = useMemo(
    () =>
      historique.slice(1).map((entree, idx) => {
        const joueur = historique[idx].etat.trait;
        const coup = entree.coup;
        const texte = !coup
          ? ""
          : coup.type === "pose"
            ? `pose un vato en ${NOMS_CASES[coup.vers]}`
            : `déplace ${NOMS_CASES[coup.de]} → ${NOMS_CASES[coup.vers]}`;
        return { n: idx + 1, joueur, texte };
      }),
    [historique]
  );

  const phrasePhase = statut.terminee
    ? "Partie terminée · vita ny lalao"
    : etat.phase === "pose"
      ? "Phase de pose · fametrahana"
      : "Phase de déplacement · fihetsiketsehana";

  const messagePrincipal = statut.terminee
    ? statut.nulle
      ? "Partie nulle — fatran-tsy misy mpandresy"
      : `Victoire de ${NOMS_JOUEURS[statut.vainqueur as Joueur]} !`
    : tourIA
      ? "L'ordinateur réfléchit…"
      : `${NOMS_JOUEURS[etat.trait]} joue`;

  const conseil = statut.terminee
    ? statut.raison ?? "La partie est terminée."
    : tourIA
      ? "Mainty (l'ordinateur) calcule son coup."
      : etat.phase === "pose"
        ? "Placez un vato sur n'importe quelle intersection libre."
        : selection === null
          ? "Cliquez sur l'un de vos vato, puis sur un point surligné."
          : "Cliquez sur un point surligné — ou sur votre vato pour annuler.";

  const curseurCase = (i: number): "pointer" | "default" => {
    if (humainBloque) return "default";
    if (etat.phase === "pose") return etat.plateau[i] === 0 ? "pointer" : "default";
    if (etat.plateau[i] === etat.trait) return "pointer";
    if (selection !== null && etat.plateau[i] === 0 && ADJACENCES[selection].includes(i)) return "pointer";
    return "default";
  };

  // Tracé de la ligne gagnante, légèrement prolongé aux deux extrémités.
  const ligneTracée = useMemo(() => {
    if (!statut.ligne) return null;
    const [a, , c] = statut.ligne;
    const [x1, y1] = COORDS[a];
    const [x2, y2] = COORDS[c];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    const ux = (dx / L) * 16;
    const uy = (dy / L) * 16;
    return { x1: x1 - ux, y1: y1 - uy, x2: x2 + ux, y2: y2 + uy };
  }, [statut.ligne]);

  const fantome = !humainBloque
    ? etat.phase === "pose"
      ? survol !== null && etat.plateau[survol] === 0
        ? survol
        : null
      : selection !== null && survol !== null && destinations.includes(survol)
        ? survol
        : null
    : null;

  /* --------------------------------- Rendu -------------------------------- */

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* Couches d'ambiance */}
      <div className="motif-fanorona pointer-events-none fixed inset-0" aria-hidden="true" />
      <div className="halos pointer-events-none fixed inset-0" aria-hidden="true" />
      <div className="vignette pointer-events-none fixed inset-0" aria-hidden="true" />

      <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-8 sm:px-6 md:pt-12">
        {/* ------------------------------ En-tête --------------------------- */}
        <header className="mb-8 flex flex-wrap items-end justify-between gap-6 md:mb-10">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.32em] text-[#c98f45]">
              Lalao nentin-drazana · jeu traditionnel de Madagascar
            </p>
            <h1 className="font-affiche mt-3 text-5xl font-extrabold leading-[0.95] tracking-tight text-[#f6ead2] sm:text-6xl md:text-7xl">
              Fanoron-<span className="text-[#e2a54c]">telo</span>
            </h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-[#c9b28c] md:text-[15px]">
              Trois <strong className="font-semibold text-[#e9d8b4]">vato</strong> (pions) chacun, huit lignes gravées
              dans le bois. Le premier qui aligne ses trois pierres remporte la partie — à condition de ne pas se
              laisser enfermer.
            </p>
          </div>
          <div className="hidden flex-col items-end gap-4 md:flex">
            <MiniPlateau />
            <div className="flex gap-2">
              {["9 toerana · intersections", "8 lalana · lignes", "3 vato · pions"].map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-[#5d4429] bg-[#2c1f12]/80 px-3 py-1 text-[11px] text-[#c9b28c]"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </header>

        {/* ------------------------------- Corps ---------------------------- */}
        <main className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px] lg:gap-8">
          {/* ------------------------- Le plateau --------------------------- */}
          <section aria-label="Plateau de fanoron-telo">
            <div
              className="relative rounded-xl p-3 shadow-2xl shadow-black/60 ring-1 ring-black/50 sm:p-5"
              style={{ background: "linear-gradient(135deg, #4c3117, #33210f 55%, #3f2a16)" }}
            >
              {/* Chevilles d'angle du cadre */}
              {[
                "left-1.5 top-1.5",
                "right-1.5 top-1.5",
                "left-1.5 bottom-1.5",
                "right-1.5 bottom-1.5",
              ].map((pos) => (
                <span
                  key={pos}
                  className={`absolute ${pos} h-2.5 w-2.5 rounded-full`}
                  style={{
                    background: "radial-gradient(circle at 35% 30%, #8a6132, #3a230f 75%)",
                    boxShadow: "inset 0 1px 1px rgba(255,220,160,.35), 0 1px 2px rgba(0,0,0,.6)",
                  }}
                  aria-hidden="true"
                />
              ))}

              <div className="overflow-hidden rounded-lg ring-1 ring-[#1d1106]">
                <svg viewBox="0 0 300 300" className="block h-auto w-full select-none" role="img" aria-label="Plateau 3 par 3 du fanoron-telo">
                  <defs>
                    <linearGradient id="boisPlateau" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#916339" />
                      <stop offset="0.5" stopColor="#7b4f28" />
                      <stop offset="1" stopColor="#69411f" />
                    </linearGradient>
                    <radialGradient id="trou" cx="0.5" cy="0.42" r="0.65">
                      <stop offset="0" stopColor="#170d04" />
                      <stop offset="1" stopColor="#3d2613" />
                    </radialGradient>
                    <radialGradient id="vatoMena" cx="0.35" cy="0.3" r="0.95">
                      <stop offset="0" stopColor="#d96a45" />
                      <stop offset="0.55" stopColor="#a83a24" />
                      <stop offset="1" stopColor="#7a2716" />
                    </radialGradient>
                    <radialGradient id="vatoMainty" cx="0.35" cy="0.3" r="0.95">
                      <stop offset="0" stopColor="#647079" />
                      <stop offset="0.55" stopColor="#3a434c" />
                      <stop offset="1" stopColor="#22282e" />
                    </radialGradient>
                    <filter id="ombreVato" x="-40%" y="-40%" width="180%" height="180%">
                      <feDropShadow dx="0" dy="2.2" stdDeviation="2" floodColor="#140b04" floodOpacity="0.55" />
                    </filter>
                  </defs>

                  {/* Bois */}
                  <rect x="4" y="4" width="292" height="292" rx="12" fill="url(#boisPlateau)" stroke="#3b2513" strokeWidth="2" />
                  <g fill="none" strokeWidth="1.2">
                    <path d="M16 62 Q150 50 284 66" stroke="#55351b" strokeOpacity="0.3" />
                    <path d="M16 112 Q150 124 284 108" stroke="#55351b" strokeOpacity="0.22" />
                    <path d="M16 192 Q150 180 284 196" stroke="#55351b" strokeOpacity="0.28" />
                    <path d="M16 242 Q150 252 284 238" stroke="#55351b" strokeOpacity="0.2" />
                    <path d="M16 88 Q150 96 284 84" stroke="#c99e63" strokeOpacity="0.12" />
                    <path d="M16 216 Q150 208 284 220" stroke="#c99e63" strokeOpacity="0.1" />
                  </g>
                  <rect x="17" y="17" width="266" height="266" rx="7" fill="none" stroke="#d8b078" strokeOpacity="0.15" />

                  {/* Lignes gravées : 3 lignes, 3 colonnes, 2 diagonales */}
                  <g stroke="#2f1c0d" strokeWidth="3.2" strokeLinecap="round">
                    <line x1="50" y1="50" x2="250" y2="50" />
                    <line x1="50" y1="150" x2="250" y2="150" />
                    <line x1="50" y1="250" x2="250" y2="250" />
                    <line x1="50" y1="50" x2="50" y2="250" />
                    <line x1="150" y1="50" x2="150" y2="250" />
                    <line x1="250" y1="50" x2="250" y2="250" />
                    <line x1="50" y1="50" x2="250" y2="250" />
                    <line x1="250" y1="50" x2="50" y2="250" />
                  </g>
                  <g stroke="#d8ab72" strokeOpacity="0.18" strokeWidth="1" strokeLinecap="round" transform="translate(0 1.1)">
                    <line x1="50" y1="50" x2="250" y2="50" />
                    <line x1="50" y1="150" x2="250" y2="150" />
                    <line x1="50" y1="250" x2="250" y2="250" />
                    <line x1="50" y1="50" x2="50" y2="250" />
                    <line x1="150" y1="50" x2="150" y2="250" />
                    <line x1="250" y1="50" x2="250" y2="250" />
                    <line x1="50" y1="50" x2="250" y2="250" />
                    <line x1="250" y1="50" x2="50" y2="250" />
                  </g>

                  {/* Repères de notation */}
                  <g fill="#e6cf9f" opacity="0.45" fontSize="12" fontFamily="inherit" textAnchor="middle" fontWeight="500">
                    <text x="50" y="24">A</text>
                    <text x="150" y="24">B</text>
                    <text x="250" y="24">C</text>
                    <text x="24" y="54">1</text>
                    <text x="24" y="154">2</text>
                    <text x="24" y="254">3</text>
                  </g>

                  {/* Intersections (trous gravés) */}
                  {COORDS.map(([x, y], i) => (
                    <circle key={`trou-${i}`} cx={x} cy={y} r="6.2" fill="url(#trou)" stroke="#201206" strokeOpacity="0.55" />
                  ))}

                  {/* Affordance : intersections libres en phase de pose */}
                  {!statut.terminee && !tourIA && etat.phase === "pose" &&
                    etat.plateau.map((v, i) =>
                      v === 0 ? (
                        <circle
                          key={`libre-${i}`}
                          cx={COORDS[i][0]}
                          cy={COORDS[i][1]}
                          r="10"
                          fill="none"
                          stroke="#e2a54c"
                          strokeOpacity="0.22"
                          strokeDasharray="3 4"
                        />
                      ) : null
                    )}

                  {/* Marqueur du dernier coup */}
                  {dernierCoup && (
                    <g pointerEvents="none">
                      {dernierCoup.de >= 0 && (
                        <circle
                          cx={COORDS[dernierCoup.de][0]}
                          cy={COORDS[dernierCoup.de][1]}
                          r="4"
                          fill="#f3e7cf"
                          opacity="0.5"
                          className="animate-pulse"
                        />
                      )}
                      <circle
                        cx={COORDS[dernierCoup.vers][0]}
                        cy={COORDS[dernierCoup.vers][1]}
                        r="24.5"
                        fill="none"
                        stroke="#f3e7cf"
                        strokeOpacity="0.3"
                        strokeDasharray="3 5"
                      />
                    </g>
                  )}

                  {/* Destinations légales (surlignées + anneau tournant) */}
                  {destinations.map((d) => (
                    <g key={`dest-${d}`} transform={`translate(${COORDS[d][0]} ${COORDS[d][1]})`} pointerEvents="none">
                      <circle r="13" fill="#e2a54c" opacity="0.16" />
                      <g className="animate-spin [animation-duration:7s]">
                        <circle r="13" fill="none" stroke="#eab25e" strokeWidth="1.8" strokeDasharray="5 7" strokeLinecap="round" opacity="0.9" />
                      </g>
                    </g>
                  ))}

                  {/* Survol d'un vato jouable */}
                  {!humainBloque &&
                    etat.phase === "deplacement" &&
                    survol !== null &&
                    etat.plateau[survol] === etat.trait &&
                    survol !== selection && (
                      <circle
                        cx={COORDS[survol][0]}
                        cy={COORDS[survol][1]}
                        r="23"
                        fill="none"
                        stroke="#f3e7cf"
                        strokeOpacity="0.3"
                        pointerEvents="none"
                      />
                    )}

                  {/* Pièces (identifiants stables → translation animée en CSS) */}
                  <g pointerEvents="none">
                    {pieces.map((p) => {
                      const [x, y] = COORDS[p.pos];
                      const estChoisie = selection === p.pos;
                      const dansLigneGagnante = statut.ligne ? statut.ligne.includes(p.pos) : false;
                      return (
                        <g
                          key={p.id}
                          style={{
                            transform: `translate(${x}px, ${y}px)`,
                            transition: "transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 450ms ease",
                            opacity: statut.ligne && !dansLigneGagnante ? 0.35 : 1,
                          }}
                        >
                          {estChoisie && (
                            <>
                              <circle r="27" fill="none" stroke="#f6ead2" strokeWidth="2" opacity="0.9" className="animate-pulse" />
                              <g className="animate-spin [animation-duration:6s]">
                                <circle r="23.5" fill="none" stroke="#eab25e" strokeWidth="1.6" strokeDasharray="4 6" strokeLinecap="round" />
                              </g>
                            </>
                          )}
                          <circle r="19" fill={p.joueur === 1 ? "url(#vatoMena)" : "url(#vatoMainty)"} stroke={p.joueur === 1 ? "#5e1d10" : "#161b20"} strokeWidth="1.5" filter="url(#ombreVato)" />
                          <circle r="13" fill="none" stroke={p.joueur === 1 ? "#e08563" : "#7c8791"} strokeWidth="1" opacity="0.5" />
                          <ellipse cx="-5.5" cy="-7" rx="7" ry="4.5" fill="#ffffff" opacity="0.16" />
                        </g>
                      );
                    })}

                    {/* Vato fantôme au survol */}
                    {fantome !== null && (
                      <circle
                        cx={COORDS[fantome][0]}
                        cy={COORDS[fantome][1]}
                        r="19"
                        fill={etat.trait === 1 ? "url(#vatoMena)" : "url(#vatoMainty)"}
                        opacity="0.35"
                        style={{ transition: "opacity 150ms ease" }}
                      />
                    )}
                  </g>

                  {/* Ligne gagnante, tracée en or */}
                  {ligneTracée && (
                    <g strokeLinecap="round" pointerEvents="none">
                      <line {...ligneTracée} stroke="#f0c264" strokeWidth="13" opacity="0.22" className="trace-ligne" />
                      <line {...ligneTracée} stroke="#f0c264" strokeWidth="6.5" opacity="0.92" className="trace-ligne" />
                    </g>
                  )}

                  {/* Couche de capture des clics (au-dessus de tout) */}
                  {COORDS.map(([x, y], i) => (
                    <circle
                      key={`clic-${i}`}
                      cx={x}
                      cy={y}
                      r="26"
                      fill="transparent"
                      style={{ cursor: curseurCase(i) }}
                      onClick={() => surClicCase(i)}
                      onMouseEnter={() => setSurvol(i)}
                      onMouseLeave={() => setSurvol((s) => (s === i ? null : s))}
                    />
                  ))}
                </svg>
              </div>
            </div>

            {/* Légende + conseil */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 px-1">
              <div className="flex items-center gap-4 text-xs text-[#c9b28c]">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-3.5 w-3.5 rounded-full" style={{ background: "radial-gradient(circle at 35% 30%, #d96a45, #7a2716)" }} />
                  Mena · rouge brique
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block h-3.5 w-3.5 rounded-full" style={{ background: "radial-gradient(circle at 35% 30%, #647079, #22282e)" }} />
                  Mainty · noir ardoise
                </span>
              </div>
              <p key={conseil} className="apparition text-xs italic text-[#a58a5f]">
                {conseil}
              </p>
            </div>
          </section>

          {/* --------------------------- Panneau latéral --------------------- */}
          <aside className="flex flex-col gap-4">
            {/* Bandeau d'état */}
            <div
              className={`rounded-lg border px-4 py-3 shadow-lg transition-colors duration-300 ${
                statut.terminee
                  ? statut.nulle
                    ? "border-[#7a6a52] bg-[#33291a]"
                    : "border-[#e8b45a] bg-[#3d2a12]"
                  : "border-[#5d4429] bg-[#2e2013]/95"
              }`}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] text-[#a58a5f]">{phrasePhase}</p>
                  <p key={messagePrincipal} className="apparition font-affiche mt-0.5 text-xl font-bold leading-snug text-[#f6ead2]">
                    {messagePrincipal}
                  </p>
                </div>
                {statut.terminee && !statut.nulle ? (
                  <IconeTrophee />
                ) : statut.terminee ? (
                  <IconeNulle />
                ) : (
                  <PastilleJoueur joueur={etat.trait} taille={34} pulse={!tourIA} />
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#c9b28c]">
                {etat.phase === "pose" && !statut.terminee && (
                  <span>
                    À poser — Mena&nbsp;: <strong className="text-[#e9d8b4]">{3 - etat.poses[0]}</strong> · Mainty&nbsp;:{" "}
                    <strong className="text-[#e9d8b4]">{3 - etat.poses[1]}</strong>
                  </span>
                )}
                <span>
                  Coup <strong className="text-[#e9d8b4]">{etat.nbCoups}</strong> / 50
                </span>
                {repetitions >= 2 && !statut.terminee && (
                  <span className="text-[#e8b45a]">Position répétée ×{repetitions}/3</span>
                )}
                {statut.terminee && statut.raison && <span className="text-[#c9b28c]">{statut.raison}</span>}
                {statut.terminee && statut.nulle && <span className="italic">Fatran-tsy misy mpandresy</span>}
              </div>
            </div>

            {/* Cartes des joueurs */}
            <CarteJoueur joueur={1} etat={etat} statut={statut} tourIA={tourIA} estIA={false} />
            <CarteJoueur joueur={2} etat={etat} statut={statut} tourIA={tourIA} estIA={mode === "ia"} />

            {/* Réglages */}
            <div className="rounded-lg border border-[#4a3520] bg-[#2c1f12] p-4 shadow-lg">
              <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[#a58a5f]">Mode de jeu</p>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-[#221809] p-1">
                <BoutonSegment actif={mode === "duo"} onClick={() => changerMode("duo")}>
                  <IconeDuo /> 2 joueurs
                </BoutonSegment>
                <BoutonSegment actif={mode === "ia"} onClick={() => changerMode("ia")}>
                  <IconeOrdi /> Ordinateur
                </BoutonSegment>
              </div>

              <div className={`mt-4 transition-opacity duration-300 ${mode === "duo" ? "pointer-events-none opacity-35" : ""}`}>
                <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[#a58a5f]">Niveau de l'ordinateur</p>
                <div className="grid grid-cols-3 gap-1 rounded-md bg-[#221809] p-1">
                  <BoutonSegment actif={niveau === "facile"} onClick={() => setNiveau("facile")}>
                    Facile
                  </BoutonSegment>
                  <BoutonSegment actif={niveau === "moyen"} onClick={() => setNiveau("moyen")}>
                    Moyen
                  </BoutonSegment>
                  <BoutonSegment actif={niveau === "difficile"} onClick={() => setNiveau("difficile")}>
                    Difficile
                  </BoutonSegment>
                </div>
                <p className="mt-1.5 text-[11px] text-[#8a7355]">
                  {niveau === "facile" && "Coup au hasard — mais saisit une victoire offerte (mora)."}
                  {niveau === "moyen" && "Minimax profondeur 3 (antonony)."}
                  {niveau === "difficile" && "Minimax profondeur 7 avec élagage α-β : il ne perd jamais (sarotra)."}
                </p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  onClick={annulerCoup}
                  disabled={historique.length <= 1}
                  className="flex items-center justify-center gap-2 rounded-md border border-[#5d4429] px-3 py-2.5 text-sm font-medium text-[#e9d8b4] transition-all duration-150 hover:border-[#7a5a33] hover:bg-[#e2a54c]/10 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                >
                  <IconeAnnuler /> Annuler le coup
                </button>
                <button
                  onClick={nouvellePartie}
                  className="flex items-center justify-center gap-2 rounded-md bg-[#e2a54c] px-3 py-2.5 text-sm font-bold text-[#241505] shadow-[0_4px_14px_-4px_rgba(226,165,76,0.55)] transition-all duration-150 hover:bg-[#eab25e] active:translate-y-px"
                >
                  <IconeRecommencer /> Nouvelle partie
                </button>
              </div>
            </div>

            {/* Journal de la partie */}
            <div className="rounded-lg border border-[#4a3520] bg-[#2c1f12] p-4 shadow-lg">
              <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[#a58a5f]">Journal de la partie</p>
              {journal.length === 0 ? (
                <p className="text-xs text-[#8a7355]">Aucun coup joué — Mena ouvre la partie.</p>
              ) : (
                <ol ref={journalRef} className="journal max-h-40 space-y-0.5 overflow-y-auto pr-1">
                  {journal.map((l) => (
                    <li
                      key={l.n}
                      className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
                        l.n === journal.length ? "apparition bg-[#e2a54c]/10 text-[#f0e4cf]" : "text-[#c9b28c]"
                      }`}
                    >
                      <span className="w-6 shrink-0 text-right font-medium tabular-nums text-[#8a7355]">{l.n}.</span>
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: l.joueur === 1 ? "#b04a2e" : "#3a434c",
                          boxShadow: "inset 0 1px 1px rgba(255,255,255,.25)",
                        }}
                      />
                      <span>
                        <strong className="font-semibold text-[#e9d8b4]">{NOMS_JOUEURS[l.joueur as Joueur]}</strong> {l.texte}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* Règles */}
            <details className="group rounded-lg border border-[#4a3520] bg-[#2c1f12] shadow-lg open:pb-4">
              <summary className="cursor-pointer list-none px-4 py-3 text-[10px] uppercase tracking-[0.24em] text-[#a58a5f] transition-colors hover:text-[#e2a54c] [&::-webkit-details-marker]:hidden">
                <span className="mr-2 inline-block transition-transform duration-200 group-open:rotate-90">▸</span>
                Règles du jeu · fitsipika
              </summary>
              <ol className="space-y-2 px-4 text-xs leading-relaxed text-[#c9b28c]">
                <li>
                  <strong className="text-[#e9d8b4]">Pose (fametrahana)</strong> — chacun pose à tour de rôle ses 3 vato
                  sur des intersections libres. Un alignement dès la pose gagne immédiatement.
                </li>
                <li>
                  <strong className="text-[#e9d8b4]">Déplacement (fihetsiketsehana)</strong> — un vato glisse le long
                  d'une ligne vers un point vide et adjacent. Le centre touche les 8 autres points. Ni saut, ni prise.
                </li>
                <li>
                  <strong className="text-[#e9d8b4]">Victoire (fandresena)</strong> — aligner ses 3 vato sur une ligne,
                  une colonne ou une diagonale.
                </li>
                <li>
                  <strong className="text-[#e9d8b4]">Blocage</strong> — le joueur qui n'a plus aucun coup légal perd la
                  partie.
                </li>
                <li>
                  <strong className="text-[#e9d8b4]">Nulle (fatrana)</strong> — même position trois fois, ou 50 coups
                  sans victoire : fatran-tsy misy mpandresy, « match nul sans vainqueur ».
                </li>
              </ol>
            </details>
          </aside>
        </main>

        {/* ------------------------------ Pied de page ---------------------- */}
        <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-[#3a2a18] pt-5 text-[11px] text-[#8a7355]">
          <p>
            Fanoron-telo · « trois alignés » — variante à trois pions du grand <em>fanorona</em> des Hautes Terres
            malgaches.
          </p>
          <p>En jeu parfait, la partie est théoriquement nulle.</p>
        </footer>
      </div>
    </div>
  );
}

/* ======================= Sous-composants d'interface ====================== */

/** Pastille de couleur du joueur, avec gradient et halo quand actif. */
function PastilleJoueur({ joueur, taille, pulse }: { joueur: Joueur; taille: number; pulse?: boolean }) {
  const gradId = joueur === 1 ? "vatoMena" : "vatoMainty";
  return (
    <span className="relative inline-flex shrink-0" style={{ width: taille, height: taille }}>
      {pulse && (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-30"
          style={{ background: joueur === 1 ? "#c05a38" : "#5b656f" }}
        />
      )}
      <svg width={taille} height={taille} viewBox="0 0 34 34" className="relative">
        <circle cx="17" cy="17" r="14" fill={`url(#${gradId})`} stroke={joueur === 1 ? "#5e1d10" : "#161b20"} strokeWidth="1.5" />
        <circle cx="17" cy="17" r="9" fill="none" stroke={joueur === 1 ? "#e08563" : "#7c8791"} strokeWidth="1" opacity="0.5" />
        <ellipse cx="13" cy="12" rx="5" ry="3.2" fill="#ffffff" opacity="0.16" />
      </svg>
    </span>
  );
}

/** Carte d'un joueur : vato en main, trait, victoire. */
function CarteJoueur({
  joueur,
  etat,
  statut,
  tourIA,
  estIA,
}: {
  joueur: Joueur;
  etat: Etat;
  statut: Statut;
  tourIA: boolean;
  estIA: boolean;
}) {
  const actif = !statut.terminee && etat.trait === joueur;
  const estVainqueur = statut.terminee && statut.vainqueur === joueur;
  const enMain = 3 - etat.poses[joueur - 1];
  return (
    <div
      className={`rounded-lg border px-4 py-3 shadow-lg transition-all duration-300 ${
        actif
          ? "border-[#e2a54c] bg-[#3a2817] shadow-[0_0_0_1px_rgba(226,165,76,0.3),0_10px_28px_-14px_rgba(0,0,0,0.9)]"
          : "border-[#4a3520] bg-[#2c1f12]"
      } ${estVainqueur ? "border-[#e8b45a] bg-[#3d2a12]" : ""}`}
    >
      <div className="flex items-center gap-3">
        <PastilleJoueur joueur={joueur} taille={30} pulse={actif} />
        <div className="min-w-0 flex-1">
          <p className="font-affiche truncate text-[15px] font-bold text-[#f6ead2]">
            {NOMS_JOUEURS[joueur]}
            <span className="ml-2 text-xs font-normal text-[#a58a5f]">
              · {joueur === 1 ? "rouge brique" : "noir ardoise"}
              {estIA ? " · ordinateur" : ""}
            </span>
          </p>
          <div className="mt-0.5 flex items-center gap-1.5">
            {etat.phase === "pose" ? (
              <>
                <span className="text-[11px] text-[#a58a5f]">En main&nbsp;:</span>
                {[0, 1, 2].map((k) => (
                  <span
                    key={k}
                    className="inline-block h-2.5 w-2.5 rounded-full border transition-colors duration-300"
                    style={{
                      background: k < enMain ? (joueur === 1 ? "#b04a2e" : "#3a434c") : "transparent",
                      borderColor: joueur === 1 ? "#7c3320" : "#4a525c",
                    }}
                  />
                ))}
              </>
            ) : (
              <span className="text-[11px] text-[#a58a5f]">3 vato en jeu</span>
            )}
          </div>
        </div>
        {estVainqueur ? (
          <span className="rounded-full border border-[#e8b45a]/60 bg-[#e2a54c]/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#eab25e]">
            Mpandresy
          </span>
        ) : actif ? (
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#e2a54c]">
            {joueur === 2 && tourIA ? (
              <span className="flex items-end gap-0.5" aria-hidden="true">
                {[0, 1, 2].map((k) => (
                  <span
                    key={k}
                    className="inline-block h-1 w-1 animate-bounce rounded-full bg-[#e2a54c]"
                    style={{ animationDelay: `${k * 130}ms` }}
                  />
                ))}
              </span>
            ) : (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#e2a54c]" />
            )}
            Au trait
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Bouton des contrôles segmentés. */
function BoutonSegment({ actif, onClick, children }: { actif: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={actif}
      className={`flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-semibold transition-all duration-150 ${
        actif
          ? "bg-[#e2a54c]/15 text-[#eab25e] ring-1 ring-[#e2a54c]/45"
          : "text-[#9a8260] hover:bg-[#e2a54c]/5 hover:text-[#e9d8b4]"
      }`}
    >
      {children}
    </button>
  );
}

/** Petit plateau décoratif pour l'en-tête. */
function MiniPlateau() {
  const pts = [20, 50, 80];
  return (
    <div className="flot rounded-lg border border-[#5d4429] bg-[#33210f] p-2 shadow-xl shadow-black/40" aria-hidden="true">
      <svg width="92" height="92" viewBox="0 0 100 100">
        <g stroke="#2f1c0d" strokeWidth="2.4" strokeLinecap="round">
          {pts.map((p) => (
            <line key={`h${p}`} x1="20" y1={p} x2="80" y2={p} />
          ))}
          {pts.map((p) => (
            <line key={`v${p}`} x1={p} y1="20" x2={p} y2="80" />
          ))}
          <line x1="20" y1="20" x2="80" y2="80" />
          <line x1="80" y1="20" x2="20" y2="80" />
        </g>
        {[
          [20, 20],
          [50, 50],
          [80, 80],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="8" fill="url(#vatoMenaMini)" stroke="#5e1d10" />
        ))}
        <defs>
          <radialGradient id="vatoMenaMini" cx="0.35" cy="0.3" r="0.95">
            <stop offset="0" stopColor="#d96a45" />
            <stop offset="1" stopColor="#7a2716" />
          </radialGradient>
        </defs>
      </svg>
    </div>
  );
}

/* ------------------------------- Icônes SVG ------------------------------- */

function IconeTrophee() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#eab25e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
    </svg>
  );
}

function IconeNulle() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#a58a5f" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 10.5h7M8.5 13.5h7" />
    </svg>
  );
}

function IconeAnnuler() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function IconeRecommencer() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconeDuo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" />
      <path d="M16 5.4a3.2 3.2 0 0 1 0 5.9M17.8 14.6a6.2 6.2 0 0 1 3.4 5.4" />
    </svg>
  );
}

function IconeOrdi() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  );
}

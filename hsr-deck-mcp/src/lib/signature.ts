// 전용 광추(전광) 매핑. 위키에는 캐릭터↔전용 광추 관계를 적은 표가 없어 별도 정리한 표(signature.json)를 쓰고,
// 표에 없는 새 캐릭터는 sync.ts가 위키 데이터로 자동 추정한 결과(derived)로 보완한다.
import data from '../data/signature.json';

export interface SignatureLC {
  id: string;
  name: string;
  /** verified: 웹/위키 교차확인 · known: 기존 지식+목록 대조(또는 위키 추천 세팅에 "전용 광추"로 명시) · probable: 정황(배너 순서 추정) */
  confidence: 'verified' | 'known' | 'probable';
  /** 자동 추정 결과일 때만: 무엇을 근거로 했는지 */
  basis?: 'wiki_recommendation' | 'warp_order';
}

interface SigFile {
  pairs: Record<string, { character: string; light_cones: SignatureLC[] }>;
  no_signature: Record<string, string>;
  pending_data?: Record<string, string>;
  _built: string;
}

const SIG = data as unknown as SigFile;

export interface DerivedSignature {
  characterId: string;
  characterName: string;
  light_cones: SignatureLC[];
}

// 런타임에 자동 추정된 전용 광추(표에 없는 캐릭터만)
let derived = new Map<string, DerivedSignature>();

export function setDerivedSignatures(list: DerivedSignature[]) {
  derived = new Map(list.map((d) => [String(d.characterId), d]));
}

export function derivedSignatureList(): DerivedSignature[] {
  return [...derived.values()];
}

export function signatureFor(characterId: string): SignatureLC[] | null {
  const id = String(characterId);
  return SIG.pairs[id]?.light_cones ?? derived.get(id)?.light_cones ?? null;
}

export function noSignatureReason(characterId: string): string | null {
  const id = String(characterId);
  return SIG.no_signature[id] ?? SIG.pending_data?.[id] ?? null;
}

export function signatureOwners(lcId: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const [cid, v] of Object.entries(SIG.pairs)) {
    if (v.light_cones.some((l) => l.id === String(lcId))) out.push({ id: cid, name: v.character });
  }
  if (!out.length) {
    for (const d of derived.values()) {
      if (d.light_cones.some((l) => l.id === String(lcId))) out.push({ id: d.characterId, name: d.characterName });
    }
  }
  return out;
}

/** 표(signature.json)에서 이미 결론이 난 캐릭터인가(전용 광추가 있거나, 없다고 확정됨). 위키 데이터 대기(pending_data)는 결론이 아니다. */
export function isStaticallyMapped(characterId: string): boolean {
  const id = String(characterId);
  return !!SIG.pairs[id] || !!SIG.no_signature[id];
}

/** 표에서 어떤 캐릭터의 전용 광추로 이미 배정된 광추 ID들 */
export function staticMappedLcIds(): Set<string> {
  const s = new Set<string>();
  for (const v of Object.values(SIG.pairs)) for (const l of v.light_cones) s.add(l.id);
  return s;
}

export const SIGNATURE_BUILT = SIG._built;

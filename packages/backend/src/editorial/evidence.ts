/** Narrow, deterministic checks for known factual losses. This is not a semantic truth oracle.
 * Match a numeric claim or a specific action, never every sentence because an unrelated paragraph
 * happens to contain “expected”. An unsafe answer is held for correction, not rewritten as fact.
 */
export interface CopyEvidence { title: string; text: string }
const modality = /预计|预期|估计|有望|预测|拟|计划|可能|或将|传闻|待核实/;
const numbers = (text: string): number[] => [...text.replace(/(?<=\d),(?=\d)/g, "").matchAll(/(\d+(?:\.\d+)?)\s*(billion|million|thousand|亿|万|千)?/gi)]
  .filter(m => !!m[2] || Number(m[1]) < 1900 || Number(m[1]) > 2100) // bare calendar years are not a shared factual quantity
  .map(m => Number(m[1]) * ({ billion: 1e9, million: 1e6, thousand: 1e3, 亿: 1e8, 万: 1e4, 千: 1e3 }[m[2]?.toLowerCase() ?? ""] ?? 1));
const sameQuantity = (a: string, b: string) => numbers(a).some(n => n >= 10 && numbers(b).includes(n));

export function copyEvidenceIssues(source: CopyEvidence, output: string): string[] {
  const issues = new Set<string>();
  const clauses = output.split(/(?<=[.!?])\s+|[。！？!?\n；;]/).filter(Boolean);
  const evidence = [source.title, ...source.text.split(/(?<=[.!?])\s+|[。！？!?\n；;]/)].filter(Boolean);
  for (const claim of clauses) for (const sentence of evidence) {
    if (/(?:expected|projected|forecast|预计|预期|预测)/i.test(sentence) && sameQuantity(sentence, claim) && !modality.test(claim)) issues.add("prediction-qualifier");
    if (/(?:proposed|plans? to|拟)/i.test(sentence) && /(?:management|manage|管理)/i.test(sentence) && /管理/.test(claim) && !modality.test(claim)) issues.add("proposal-qualifier");
    if (/(?:felt|feels?|perceived|感到|感觉)/i.test(sentence) && /(?:urgency|紧迫)/i.test(sentence) && /紧迫|迟缓|延迟|拖延/.test(claim) && !/表示|认为|感到|感觉|称|受访/.test(claim)) issues.add("subjective-attribution");
    if (/(?:another role|reassigned|调任|转任)/i.test(sentence) && /解雇|开除|辞退|被航空公司除名/.test(claim) && !/dismissed|fired|解雇|开除|辞退/i.test(`${source.title} ${source.text}`)) issues.add("reassignment-not-dismissal");
    if (/(?:investigation.{0,30}reopen|reopen.{0,30}investigation|调查.{0,10}重启)/i.test(sentence) && !/court hearing|庭审|开庭/i.test(`${source.title} ${source.text}`) && /重新开庭|再次开庭|庭审重启/.test(claim)) issues.add("investigation-not-hearing");
    if (/(?:\d[\d,]*\s*(?:words|词))/i.test(sentence) && /\d[\d,]*\s*(?:多)?字/.test(claim) && sameQuantity(sentence, claim)) issues.add("word-not-character-unit");
  }
  if (/World Series/i.test(source.title) && /(?:参加|举行|举办|赛事|赛站|开赛).{0,12}世界杯|世界杯.{0,12}(?:赛事|赛站|开赛)/.test(output) && !/世界系列赛|World Series/i.test(output)) issues.add("competition-proper-name");
  const all = `${source.title}\n${source.text}`;
  if (/\bjobs\b/i.test(all) && !/non[- ]?farm|非农/i.test(all) && /非农/.test(output) && sameQuantity(all, output)) issues.add("unsupported-employment-qualifier");
  return [...issues];
}

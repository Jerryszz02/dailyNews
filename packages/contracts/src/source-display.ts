/** Public display only: source IDs, stored names and publisher attribution stay unchanged. */
const SOURCE_LABELS: Record<string, string> = {
  "Al Jazeera": "半岛电视台",
  Anthropic: "Anthropic 官方动态",
  "Associated Press": "美联社",
  "Ars Technica": "科技媒体 Ars Technica",
  BBC: "英国广播公司",
  Bloomberg: "彭博社",
  CNBC: "美国消费者新闻与商业频道",
  CNN: "美国有线电视新闻网",
  ESPN: "ESPN 体育",
  "Google AI": "Google AI 官方动态",
  "Google DeepMind": "Google DeepMind 官方动态",
  "Hugging Face": "Hugging Face 官方动态",
  "Meta AI": "Meta AI 官方动态",
  "Microsoft AI": "Microsoft AI 官方动态",
  "NVIDIA AI": "NVIDIA AI 官方动态",
  NPR: "美国国家公共广播电台",
  OpenAI: "OpenAI 官方动态",
  Reuters: "路透社",
  "Shams Charania": "沙姆斯·查拉尼亚",
  TechCrunch: "科技媒体 TechCrunch",
  "MIT Technology Review": "麻省理工科技评论",
  "The Guardian": "卫报",
  "The Verge": "科技媒体 The Verge",
  "OpenAI X": "OpenAI 社交动态",
  "Anthropic X": "Anthropic 社交动态",
  "Google DeepMind X": "Google DeepMind 社交动态",
  "Sam Altman X": "Sam Altman 社交动态",
  "Greg Brockman X": "Greg Brockman 社交动态",
  "Andrej Karpathy X": "Andrej Karpathy 社交动态",
  Wired: "连线",
  "苹果新闻室 Apple Newsroom": "苹果新闻室",
  "NBA官网": "NBA 官网",
};

const SECTION_LABELS: Record<string, string> = {
  Newsroom: "新闻",
  World: "国际",
  Business: "商业",
  Film: "电影",
  "Press Releases": "新闻稿",
  "NBA News": "NBA 新闻",
  News: "新闻",
  AI: "人工智能",
  Science: "科学",
};

/** Mirrors the legacy sourceLabel fallback while localizing reviewed English section names. */
export function displaySourceName(name: string): string {
  const section = /^(.+?)\s*·\s*(.+)$/.exec(name);
  if (!section) return Object.hasOwn(SOURCE_LABELS, name) ? SOURCE_LABELS[name]! : name;
  // Unknown Latin publishers keep their complete stored name until reviewed.
  if (!Object.hasOwn(SOURCE_LABELS, section[1]!) && !/\p{Script=Han}/u.test(section[1]!)) return name;
  const base = Object.hasOwn(SOURCE_LABELS, section[1]!) ? SOURCE_LABELS[section[1]!]! : section[1]!;
  const label = Object.hasOwn(SECTION_LABELS, section[2]!) ? SECTION_LABELS[section[2]!]! : section[2]!;
  return `${base} · ${label}`;
}

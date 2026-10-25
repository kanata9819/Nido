import {
  BookOpen,
  Braces,
  Container,
  Database,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  GitBranch,
  Package,
  ScrollText,
  type LucideIcon
} from 'lucide-react';
import rust from '../assets/file-icons/rust.svg';
import typescript from '../assets/file-icons/typescript.svg';
import javascript from '../assets/file-icons/javascript.svg';
import react from '../assets/file-icons/react.svg';
import python from '../assets/file-icons/python.svg';
import go from '../assets/file-icons/go.svg';
import c from '../assets/file-icons/c.svg';
import cpp from '../assets/file-icons/cplusplus.svg';
import csharp from '../assets/file-icons/csharp.svg';
import html from '../assets/file-icons/html5.svg';
import css from '../assets/file-icons/css3.svg';
import lua from '../assets/file-icons/lua.svg';

const icons: Record<string, string> = {
  rs: rust,
  ts: typescript,
  mts: typescript,
  cts: typescript,
  js: javascript,
  mjs: javascript,
  cjs: javascript,
  tsx: react,
  jsx: react,
  py: python,
  pyw: python,
  pyi: python,
  go,
  c,
  h: c,
  cpp,
  cc: cpp,
  cxx: cpp,
  hpp: cpp,
  hxx: cpp,
  hh: cpp,
  cs: csharp,
  html,
  htm: html,
  css,
  scss: css,
  sass: css,
  less: css,
  lua
};

const fileKinds: [RegExp, LucideIcon, string][] = [
  [/^(readme|changelog|license|licence|copying|authors)(\..+)?$/, BookOpen, '#80b9d9'],
  [/^\.git(ignore|attributes|modules|keep)?$/, GitBranch, '#e59277'],
  [/^\.env(\..+)?$/, FileKey, '#dcdcaa'],
  [/^(dockerfile(\..+)?|compose\.(ya?ml)|docker-compose(\..+)?\.ya?ml)$/, Container, '#80b9d9'],
  [
    /^(cargo\.(toml|lock)|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.(mod|sum))$/,
    Package,
    '#d9b777'
  ],
  [/^\.(editorconfig|npmrc|nvmrc|prettierrc|eslintrc)(\..+)?$/, FileCog, '#b6a2d8'],
  [/\.(log(\.\d+)?|trace)$/, ScrollText, '#dcdcaa'],
  [/\.(jsonc?|jsonl|ndjson)$/, Braces, '#dcdcaa'],
  [/\.(toml|ya?ml|ini|conf|cfg|properties)$/, FileCog, '#b6a2d8'],
  [/\.(lock|pem|key|crt|pfx)$/, FileLock, '#d9b777'],
  [/\.(sh|bash|zsh|fish|ps1|psm1|psd1|bat|cmd)$/, FileTerminal, '#80b9d9'],
  [/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/, FileImage, '#b6a2d8'],
  [/\.(mp3|wav|ogg|flac|m4a|aac)$/, FileMusic, '#d89ab6'],
  [/\.(mp4|webm|mkv|mov|avi)$/, FileVideoCamera, '#d89ab6'],
  [/\.(zip|7z|rar|tar|gz|bz2|xz|zst)$/, FileArchive, '#d9b777'],
  [/\.(db|sqlite3?|sql)$/, Database, '#80b9d9'],
  [/\.(csv|tsv|xlsx?|ods)$/, FileSpreadsheet, '#9fc68e'],
  [/\.(mdx?|txt|rst|adoc)$/, FileText, '#80b9d9'],
  [/\.(pdf|docx?|odt)$/, FileType, '#e59b96']
];

export default function FileIcon({
  path,
  className
}: {
  path: string;
  className?: string;
}): React.JSX.Element {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() || '';
  const kind = fileKinds.find(([pattern]) => pattern.test(name));
  const src = !kind && icons[name.split('.').pop() || ''];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={16}
        height={16}
        className={className}
        style={{ flexShrink: 0 }}
      />
    );
  }
  const Icon = kind?.[1] || FileCode2;
  return (
    <Icon
      size={16}
      aria-hidden="true"
      className={className}
      style={{ color: kind?.[2] || '#83b7d2', flexShrink: 0 }}
    />
  );
}

import { FileCode2, FileCog, FileText } from 'lucide-react';
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
  go,
  c,
  h: c,
  cpp,
  cc: cpp,
  cxx: cpp,
  hpp: cpp,
  cs: csharp,
  html,
  htm: html,
  css,
  lua
};

export default function FileIcon({ path, className }: { path: string; className?: string }): React.JSX.Element {
  const extension = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || '';
  const src = icons[extension];
  if (src) {
    return (
      <img src={src} alt="" aria-hidden="true" width={16} height={16} className={className} style={{ flexShrink: 0 }} />
    );
  }
  const Icon = ['toml', 'json', 'yaml', 'yml', 'ini', 'lock'].includes(extension)
    ? FileCog
    : ['md', 'txt'].includes(extension)
      ? FileText
      : FileCode2;
  return <Icon size={16} aria-hidden="true" className={className} />;
}

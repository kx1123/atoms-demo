import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Atoms · 把想法变成应用', description: '通过对话构建、预览与迭代网页应用。' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

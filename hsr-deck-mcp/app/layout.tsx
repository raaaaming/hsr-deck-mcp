import type { ReactNode } from 'react';

export const metadata = {
  title: 'HSR Deck MCP',
  description: '붕괴: 스타레일 덱 빌딩용 MCP 서버 (HoYoWiki 데이터 추출 + 스탯/유물 계산기)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: 760, padding: '0 1rem', lineHeight: 1.6 }}>{children}</body>
    </html>
  );
}

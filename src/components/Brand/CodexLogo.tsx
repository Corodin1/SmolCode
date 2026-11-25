import catLogoPng from './cat-logo.png';

interface CodexLogoProps {
  size?: number;
  variant?: 'glyph' | 'tile';
}

export function CodexLogo({ size = 26, variant = 'glyph' }: CodexLogoProps) {
  if (variant === 'tile') {
    return (
      <img
        src={catLogoPng}
        width={size}
        height={size}
        alt="SmolCode"
        style={{
          display: 'block',
          borderRadius: '22%',
          border: '1px solid rgba(0, 0, 0, 0.08)',
          objectFit: 'cover',
        }}
      />
    );
  }

  return (
    <img
      src={catLogoPng}
      width={size}
      height={size}
      alt="SmolCode"
      style={{
        display: 'block',
        borderRadius: '22%',
        objectFit: 'cover',
      }}
    />
  );
}

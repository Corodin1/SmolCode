import logoUrl from '../../assets/logo.png';

interface CodexLogoProps {
  size?: number;
  variant?: 'glyph' | 'tile';
}

export function CodexLogo({ size = 26, variant = 'glyph' }: CodexLogoProps) {
  return (
    <img
      src={logoUrl}
      alt="SmolCode"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: variant === 'tile' ? '22%' : '18%',
        objectFit: 'contain',
        display: 'block',
      }}
    />
  );
}

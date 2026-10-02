import { Img } from "remotion";

type Props = {
  readonly src: string;
  readonly height: number;
};

export const BrandMark: React.FC<Props> = ({ src, height }) => (
  <div style={{ height, display: "flex", alignItems: "center" }}>
    <Img src={src} style={{ height: "100%", width: "auto" }} />
  </div>
);

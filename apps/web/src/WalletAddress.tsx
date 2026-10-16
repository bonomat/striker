import { QRCodeSVG } from "qrcode.react";

export function WalletAddress({ address }: { address: string }) {
  return (
    <>
      <div className="wallet-address-qr">
        <QRCodeSVG
          value={address}
          size={224}
          level="M"
          marginSize={4}
          title="Arkade wallet address"
          role="img"
          aria-label="Scan this QR code to receive assets on Arkade"
        />
        <span>Scan to receive on Arkade</span>
      </div>
      <div className="address-box">{address}</div>
    </>
  );
}

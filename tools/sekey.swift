// The Mac half of the release keys (tools/sign.mjs): a P-256 key made inside this Mac's Secure Enclave.
// It never leaves the chip and every signature needs Touch ID (or the Mac's password). The file it keeps
// (~/.wedgie/release-se.key) is only a handle: no other Mac, and no copy of the file, can sign with it.
//   swiftc -O tools/sekey.swift -o ~/.wedgie/sekey
//   ~/.wedgie/sekey new <file>        make the key; prints its public key: "x y" in hex
//   ~/.wedgie/sekey pub <file>        the public key again
//   ~/.wedgie/sekey sign <file>       signs stdin (SHA-256, P-256); prints "r s" in hex
import CryptoKit
import Foundation
import LocalAuthentication

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func die(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }
func pub(_ k: SecureEnclave.P256.Signing.PrivateKey) -> String {
  let r = k.publicKey.rawRepresentation
  return hex(r.prefix(32)) + " " + hex(r.suffix(32))
}

let a = CommandLine.arguments
guard a.count == 3 else { die("usage: sekey new|pub|sign <file>") }
let path = URL(fileURLWithPath: a[2])
do {
  switch a[1] {
  case "new":
    if FileManager.default.fileExists(atPath: path.path) { die("\(path.path) is there already: not making another") }
    var err: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err)
    else { die("access control: \(String(describing: err))") }
    let k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac)
    try k.dataRepresentation.write(to: path, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    print(pub(k))
  case "pub":
    print(pub(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: Data(contentsOf: path))))
  case "sign":
    let ctx = LAContext()
    ctx.localizedReason = "sign a wedgie release"
    let k = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: Data(contentsOf: path), authenticationContext: ctx)
    let sig = try k.signature(for: FileHandle.standardInput.readDataToEndOfFile()).rawRepresentation
    print(hex(sig.prefix(32)) + " " + hex(sig.suffix(32)))
  default:
    die("usage: sekey new|pub|sign <file>")
  }
} catch { die("sekey: \(error)") }

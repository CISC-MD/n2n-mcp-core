@0xdb4a5f23a1b2c3d4;

struct McpMessage {
  jsonrpc @0 :Text;
  id @1 :UInt64;
  method @2 :Text;
  targetNode @3 :Data; # 16 bytes raw UUID
  payload @4 :Data;    # Encapsulated binary packet or raw JSON-LD
}

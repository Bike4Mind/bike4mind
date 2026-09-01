{
  description = "lumina5 development environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm_10
              # Required on macOS, not a convenience -- omitting it is a fork bomb.
              #
              # With no git in this shell, `git` falls through to macOS's /usr/bin/git shim. That
              # shim finds its real binary via DEVELOPER_DIR, NOT via PATH -- and this shell's own
              # darwin stdenv sets DEVELOPER_DIR to a nix apple-sdk whose `xcrun` is xcbuild's
              # reimplementation. xcbuild's xcrun does not do developer-dir tool resolution; it
              # falls back to PATH, finds /usr/bin/git, and the two call each other with no base
              # case. Any `git` invocation then forks until the machine is unusable (observed:
              # 5,000+ processes, terminal emulator pegged, shell startup ~60x slower).
              #
              # Providing git here puts a real git ahead of the shim on PATH, so the shim is never
              # reached. Do not remove without also clearing DEVELOPER_DIR/SDKROOT in a shellHook.
              pkgs.git
              pkgs.mongosh
              pkgs.ollama
              pkgs.stripe-cli
              pkgs.gitleaks
              pkgs.python3
            ];
          };
        }
      );
    };
}

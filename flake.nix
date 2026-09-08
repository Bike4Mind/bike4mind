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
              # Required on macOS, not a convenience: without it, `git` in this shell is a
              # fork bomb.
              #
              # /usr/bin/git is not git. It is one of 78 hard links to a single
              # com.apple.dt.xcode_select.tool-shim binary, which resolves the real tool through
              # libxcselect.dylib (see `otool -L /usr/bin/git`). That library ships only inside the
              # dyld shared cache, so how it reacts to this shell's DEVELOPER_DIR -- pointed at a
              # nix apple-sdk by the darwin stdenv -- cannot be audited from here, only observed:
              # every `git` call forks without bound. 5,000+ processes, terminal emulator pegged,
              # shell startup ~60x slower. Do not reproduce it to check.
              #
              # A real git ahead of the shim on PATH means the shim is never reached. Keep it here.
              #
              # This closes one hole, not the class: 48 of those 78 shim names still resolve to
              # /usr/bin inside this shell (gcc, gnumake, m4, libtool, swift, lldb, yacc). The
              # names a Node build actually reaches -- cc, clang, make, ld, ar, nm, strip -- come
              # from stdenv, which is why git is the one that has bitten.
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

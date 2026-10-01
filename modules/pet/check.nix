# The VR pet's tests (package.nix `tests`): the core with scripted hands,
# the SteamVR adapter in a fake systemui page, the CLI, the model catalog
# (also a private model added like extraModels, and the refusal of a private
# built-in one), the glTF reshaping, the "+" menu's icons, entry and icon
# link. Bakes the built-in models (no Blender).
{ pkgs }:
(import ./package.nix { inherit pkgs; }).tests

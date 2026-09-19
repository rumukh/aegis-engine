export const SCENE = 'games/horror/levels/null-meridian.scene.json';
export const SEED = 'null-meridian-1';
export const WIN_TICKS = 8217;
export const CAUGHT_TICKS = 3900;

export const POWER_ROUTE = `
# Inspect the wall-mounted arrival terminal, then diagnose and isolate the failed rescue bus.
aim 0 0 @10
axis Forward 1 10..100
aim 90 0 @102
axis Forward 1 102..192
aim 90 0 @194
hold Interact 196..197
aim -90 0 @200
axis Forward 1 200..290
aim 0 0 @292
axis Forward 1 292..472
aim -90 0 @474
axis Forward 1 474..834
aim 180 0 @836
axis Forward 1 836..896
aim 180 0 @898
hold Interact 900..901
aim 90 0 @904
axis Forward 1 904..1084
aim 0 0 @1086
axis Forward 1 1086..1296
aim -90 0 @1298
hold Interact 1300..1301
aim 0 0 @1304
axis Forward 1 1304..1454
aim -90 0 @1456
axis Forward 1 1456..1606
aim 0 0 @1608
hold Interact 1610..1730
aim 90 0 @1733
axis Forward 1 1733..1793
aim 0 0 @1795
axis Forward 1 1795..1915
aim 90 0 @1917
axis Forward 1 1917..2007
aim 0 0 @2009
axis Forward 1 2009..2129
aim 0 0 @2131
hold Interact 2133..2193
aim -90 0 @2196
axis Forward 1 2196..2376
aim 0 0 @2378
press Select @2380
aim 0 0 @2382
press Select @2384
aim 0 0 @2386
hold Interact 2388..2478
`;

export const WIN_ROUTE = `${POWER_ROUTE}
# Light off; recover visitor authorization in the infirmary and then the archive black box.
press Flashlight @2481
aim 90 0 @2481
axis Forward 1 2481..2841
aim 180 0 @2843
axis Forward 1 2843..3383
aim 90 0 @3385
axis Forward 1 3385..3775
aim 0 0 @3777
axis Forward 1 3777..3807
aim 90 0 @3809
hold Interact 3811..3812
aim 0 0 @3815
axis Forward 1 3815..3965
aim -90 0 @3967
axis Forward 1 3967..4087
aim 0 0 @4089
axis Forward 1 4089..4209
aim 90 0 @4211
axis Forward 1 4211..4301
aim 0 0 @4303
axis Forward 1 4303..4543
aim -90 0 @4545
axis Forward 1 4545..4725
aim 0 0 @4727
hold Interact 4729..4819
# The returning responder spots this exit. Sprint around the maintenance wall and machinery.
aim -90 0 @4822
axis Forward 1 4822..4852
aim 180 0 @4854
axis Forward 1 4854..5094
aim -90 0 @5096
hold Sprint 5096..5254
axis Forward 1 5096..5254
aim 180 0 @5256
hold Sprint 5256..5414
axis Forward 1 5256..5414
aim -90 0 @5416
axis Forward 1 5416..5626
aim 0 0 @5628
axis Forward 1 5628..5928
# The search has expired before the return-line valve is operated.
aim 0 0 @5930
press Select @5932
aim 0 0 @5934
hold Interact 5936..6086
aim 90 0 @6089
axis Forward 1 6089..6449
aim 0 0 @6451
axis Forward 1 6451..6901
# The observation approach reveals the window before turning to its opaque left uplink flank.
aim -90 0 @6903
axis Forward 1 6903..7173
aim 0 0 @7175
axis Forward 1 7175..7205
aim 0 0 @7207
press Select @7209
aim 0 0 @7211
hold Interact 7213..7333
aim 180 0 @7336
axis Forward 1 7336..7366
aim 90 0 @7368
axis Forward 1 7368..8028
aim 0 0 @8030
axis Forward 1 8030..8060
aim 90 0 @8062
hold Interact 8064..8154
`;

export const CAUGHT_ROUTE = `${POWER_ROUTE}
# Stand in the returning responder's lane instead of avoiding it or breaking sight.
aim 90 0 @2481
axis Forward 1 2481..2841
aim 180 0 @2843
axis Forward 1 2843..3083
aim 90 0 @3085
axis Forward 1 3085..3235
hold Interact 3500..3800
press Flashlight @3501
`;

export const LOCKED_ROUTE = `
# A straight rush cannot bypass the observation quarantine.
axis Forward 1 0..1800
hold Interact 1600..1700
`;

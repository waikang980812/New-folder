"use strict";

const creeps = require('creeps');
const pathing = require('pathing');
const scan = require('scan');
const taskconsts = require('tasks');
const utilities = require('utilities');


const storageWithdrawingThresholds = {'default': 200000, 'siege': 50000};
let findConstsToFilters = [{}, {}, {}, {}, {}];
const ignoreUnbreakable = filter => {
    return s => {
        return s.hits != undefined && s.structureType != STRUCTURE_CONTROLLER && filter(s) && !s.my;
    };
};
findConstsToFilters[0][FIND_HOSTILE_SPAWNS] = entity => true;
// ignore roads and the storage for now, since they can have a lot of hitpoints
findConstsToFilters[1][FIND_HOSTILE_STRUCTURES] = ignoreUnbreakable(s => ![STRUCTURE_RAMPART, STRUCTURE_ROAD, STRUCTURE_STORAGE].includes(s.structureType));
findConstsToFilters[2][FIND_HOSTILE_STRUCTURES] = ignoreUnbreakable(s => s.structureType != STRUCTURE_RAMPART && s.structureType != STRUCTURE_ROAD);
findConstsToFilters[3][FIND_STRUCTURES] = s => s.structureType == STRUCTURE_WALL || s.structureType == STRUCTURE_RAMPART;
// destroy roads at the very end since they speed up travel to other structures (and decay on their own anyway)
findConstsToFilters[4][FIND_STRUCTURES] = ignoreUnbreakable(entity => true);



function UnexpectedCTypeException(message) {
    this.message = message;
}

function getStrgWThreshold(room) {
    return storageWithdrawingThresholds[utilities.getMode(room)];
}


function idle(creep) {
    if (creep.memory.noIdling) return 1;
    creep.memory.oldTaskId = creep.memory.taskId;
    creep.memory.taskId = -1;
    if (Memory[creep.room.name] == undefined) return;
    if (Memory[creep.room.name].taskIdsToBlockageTimes == undefined) {
        Memory[creep.room.name].taskIdsToBlockageTimes = {};
    }

    Memory[creep.room.name].taskIdsToBlockageTimes[creep.memory.oldTaskId] = Game.time;
}

function travelToExpansionTarget(creep, idleOnFailure = true) {
    if (!idleOnFailure) creep.memory.noIdling = true;

    if (creep.memory.roomToSamplePos == undefined) {
        const flag = utilities.getFlagToScout(creep.room);
        if (flag == undefined) {
            idle(creep);
            return false;
        }
        creep.memory.roomToSamplePos = flag.pos;
        if (creep.memory.roomToSamplePos == undefined) {
            idle(creep);
            return false;
        }
    }

    const shouldWaitForTank = creep => {
        const typesToWait = [creeps.types.BRUISER, creeps.types.MARKSMAN, creeps.types.MEDIC, creeps.types.DEMOLISHER];

        for (const type of typesToWait) {
            if (creep.memory.type == type) return true;
        }
        return false;
    };

    const goToTarget = creep => {
        const target = creep.memory.roomToSamplePos;
        creep.moveTo(utilities.objToRoomPos(target));
        return false;
    };

    if (shouldWaitForTank(creep)) {
        const localTank = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: scan.tankFilter
        });

        if (localTank != undefined && !localTank.memory.tankedTowerEnergy) {
            if (creep.hits == creep.hitsMax) {
                if (scan.medicFilter(creep) && creep.pos.getRangeTo(localTank) > 1) {
                    creep.moveTo(localTank);
                } else if (creep.pos.getRangeTo(localTank) > 5) { // keep leaders pulled back until towers are empty
                    pathing.walkCheapestPath(creep, [localTank], 5, false, 5);
                }
            }

            return false;
        } else {
            return creep.room.name != creep.memory.roomToSamplePos.roomName ? goToTarget(creep) : true;
        }
    } else {
        if (creep.room.name != creep.memory.roomToSamplePos.roomName) {
            creep.memory.stepsInTargetRoom = 0;
            return goToTarget(creep);
        } else {
            return creep.memory.stepsInTargetRoom++ > 2 ? true : goToTarget(creep);
        }
    }
}

// orderedTargetSpecifiers need to be order by descending interaction priority
function interactWithTargets(creep, orderedTargetSpecifiers, action, actionRange) {
    let targets;
    for (const spec of orderedTargetSpecifiers) {
        let [findConst, f] = Object.entries(spec)[0];
        findConst = parseInt(findConst);
        targets = creep.pos.findInRange(findConst, actionRange, {filter: f});

        if (targets.length > 0) {
            action(creep, targets[0]);
            return true;
        } else if (pathing.walkCheapestPath(creep, creep.room.find(findConst, {filter: f}), 5, false, actionRange)) {
            return true;
        }
    }

    return false;
}

function supportExpansionTroops(creep, stationary = false) {
    if (!stationary) {
        creep.moveTo(creep.pos.findClosestByPath(FIND_MY_CREEPS, {filter: c => scan.bruiserFilter(c) || scan.demolisherFilter(c)}));
    }

    if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
    } else {
        const targets = creep.pos.findInRange(FIND_MY_CREEPS, 1, {filter: c => c.hits < c.hitsMax});
        if (targets.length > 0) {
            creep.heal(targets[0]);
        } else {
            const targets = creep.pos.findInRange(FIND_MY_CREEPS, 3, {filter: c => c.hits < c.hitsMax});
            if (targets.length > 0) creep.rangedHeal(targets[0]);
        }
    }
}

// uses as little API calls as possible to minimize artificial CPU costs
// (as a result of that, some of the conditionals might seem weirdly layered)
function kiteHostiles(creep, orderedFallbackTargetSpecifiers, defaultTask = 'escort') {
    const targetAction = (creep, target) => creep.rangedAttack(target);
    const actionRange = 3;
    const safetyRange = 4;

    const findNearestEnemyCloseTo = (creep, proximitySpecifier) => {
        return creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
            filter: c => {
                return c.pos.findInRange(proximitySpecifier.findConst, proximitySpecifier.range, {
                    filter: proximitySpecifier.filter
                }).length > 0
            }
        });
    };

    const handleDangerousEnemies = (creep, triedToAttack) => {
        if (triedToAttack && creep.pos.findInRange(FIND_HOSTILE_CREEPS, safetyRange, {filter: utilities.canAttack}).length > 0) {
            if (!pathing.walkCheapestPath(creep, FIND_HOSTILE_CREEPS, 3, false, actionRange, false, true)) {
                creep.moveTo(creep.pos.findClosestByPath(FIND_MY_CREEPS, {filter: scan.medicFilter}));
            }
        } else {
            const proximitySpec = {
                findConst: FIND_MY_CREEPS,
                range: safetyRange + 2,
                filter: c => scan.bruiserFilter(c) || scan.demolisherFilter(c) || scan.medicFilter(c)
            };
            const target = findNearestEnemyCloseTo(creep, proximitySpec);
            if (target) {
                creep.moveTo(target);
            } else {
                if (defaultTask == 'demolish') return true;
                creep.moveTo(creep.pos.findClosestByPath(FIND_MY_CREEPS, {filter: c => scan.bruiserFilter(c) || scan.demolisherFilter(c)}));
                if (!triedToAttack) {
                    const targets = creep.pos.findInRange(FIND_HOSTILE_STRUCTURES, actionRange);
                    if (targets.length > 0) targetAction(creep, targets[0]);
                }
            }
        }
    }

    const targets = creep.pos.findInRange(FIND_HOSTILE_CREEPS, actionRange);
    const triedToAttack = targets.length > 0 && [OK, ERR_NO_BODYPART].includes(targetAction(creep, targets[0]));

    const nearestHealer = creep.pos.findClosestByPath(FIND_MY_CREEPS, {filter: scan.medicFilter});
    if (creep.hits/creep.hitsMax < 2/3 && nearestHealer) {
        creep.moveTo(nearestHealer);
    } else {
        const enemies = creep.room.find(FIND_HOSTILE_CREEPS);
        if (enemies.length > 0) {
            const dangerousEnemiesExist = enemies.filter(utilities.canAttack).length > 0;
            if (!dangerousEnemiesExist) {
                creep.moveTo(creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS));
            } else {
                if (handleDangerousEnemies(creep, triedToAttack)) {
                    return interactWithTargets(creep, orderedFallbackTargetSpecifiers, targetAction, actionRange);
                }
            }
        } else {
            return interactWithTargets(creep, orderedFallbackTargetSpecifiers, targetAction, actionRange);
        }
    }
}

function expandAggressively(creep) {
    if (!travelToExpansionTarget(creep)) {
        if (scan.medicFilter(creep)) {
            supportExpansionTroops(creep, true);
        }
        return;
    }

    if (scan.tankFilter(creep)) {
        const dangerousTowerExists = creep.room.find(FIND_HOSTILE_STRUCTURES, {
            filter: scan.towerFilter
        }).filter(tower => {
            return tower.store[RESOURCE_ENERGY] >= 10;
        }).length > 0;

        const towerTarget = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {filter: scan.towerFilter});
        const moveToTower = creep => {
            creep.moveTo(towerTarget);
        };

        const calcHitsDelta = creep => {
            const res = creep.memory.previousHits == undefined ? 0 : creep.hits - creep.memory.previousHits;

            creep.memory.previousHits = creep.hits;

            return res;
        };

        const hitsDelta = calcHitsDelta(creep);
        const hitsQuotient = creep.hits/creep.hitsMax;

        if (!dangerousTowerExists || utilities.calcDistance(creep.pos, towerTarget.pos) < 2) {
            creep.memory.tankedTowerEnergy = true;
            moveToTower(creep);
        } else if (hitsQuotient >= 0.9 || hitsDelta >= 0 && hitsQuotient >= 0.7) {
            moveToTower(creep);
        }

    } else if (scan.bruiserFilter(creep)) {
        // omitted logic to attack hostile creeps since that is not the main objective and creeps with ATTACK body parts hit back automatically anyway
        interactWithTargets(creep, findConstsToFilters, (creep, target) => creep.attack(target), 1);
    } else if (scan.marksmanFilter(creep)) {
        kiteHostiles(creep, findConstsToFilters);
    } else if (scan.medicFilter(creep)) {
        supportExpansionTroops(creep);
    } else if (scan.demolisherFilter(creep)) {
        interactWithTargets(creep, findConstsToFilters, (creep, target) => creep.dismantle(target), 1);
    } else {
        throw new UnexpectedCTypeException();
    }
}

function claim(creep) {
    if (creep.memory.claimedCtrl) {
        creep.moveTo(Game.spawns[creep.name.split('_')[0]].pos);
        return;
    }

    if (!travelToExpansionTarget(creep, false)) return;

    if (!kiteHostiles(creep, findConstsToFilters.slice(0, 2), 'demolish')) {
        if (creep.room.controller) {
            const result = creep.claimController(creep.room.controller);
            switch (result) {
                case ERR_NOT_IN_RANGE:
                    creep.moveTo(creep.room.controller);
                    break;
                case ERR_GCL_NOT_ENOUGH:
                    creep.reserveController(creep.room.controller)
                    utilities.log('The room "' + creep.room.name + '" couldn\'t be claimed: GCL not sufficient - reserving instead.', true);
                    break;
                case ERR_FULL:
                    utilities.log('The room "' + creep.room.name + '" couldn\'t be claimed: reached maximum amount of rooms in the novice area.', true);
                    break;
                case ERR_INVALID_TARGET:
                    creep.attackController(creep.room.controller);
                default:
                    creep.memory.claimedCtrl = true;
            }
        } else {
            utilities.log('The room "' + creep.room.name + '" has no controller and can\'t be claimed for that reason!', true);
        }
    }
}

function rmInvalidTask(creep, validTasks) {
    if (creep.memory.task != undefined && !validTasks.includes(creep.memory.task)) {
        creep.memory.task = undefined;
    }
}

// if the optional parameter 'noIdling' is set to true, this function won't set the given creep to an idle state
// instead it will return 1
function construct(creep, siteFilter, noIdling = false, safePathing = false, rangeOverride = null) {
    const range = rangeOverride == null ? 3 : rangeOverride;
    if (noIdling) creep.memory.noIdling = true;

    rmInvalidTask(creep, ['building', 'harvesting']);
    if (creep.memory.task == 'building' && creep.store[RESOURCE_ENERGY] == 0 || creep.memory.task == undefined) {
        creep.memory.task = 'harvesting';
    }

    if (creep.memory.task == 'harvesting' && creep.store.getFreeCapacity() == 0) {
        creep.memory.task = 'building';
    }

    if (creep.memory.task == 'building' && creep.memory.building == null) {
        const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES, {filter: siteFilter});
        if (sites.length == 0) {
            return idle(creep);
        } else {
            let maxProgressRatio = 0;
            let maxIndex = 0;
            let progressRatio = null;
            for (let i = 0; i < sites.length; i++) {
                progressRatio = sites[i].progress/sites[i].progressTotal;
                if (progressRatio > maxProgressRatio) {
                    maxProgressRatio = progressRatio;
                    maxIndex = i;
                }
            }
            // prevents WALL construction blocking by WALLs that can't be built safely
            // (and should not be built at all)
            if (maxProgressRatio == 0) {
                maxIndex = Math.floor(Math.random() * (sites.length));
            }
            creep.memory.building = {'pos': sites[maxIndex].pos};
        }
    }

    if (creep.memory.task == 'building') {
        if (creep.memory.building != null) {
            if (creep.pos.inRangeTo(creep.memory.building.pos.x, creep.memory.building.pos.y, range)) {
                const firstMatch = creep.room.lookAt(creep.memory.building.pos.x, creep.memory.building.pos.y)
                    .filter(e => e.constructionSite)[0];
                if (!firstMatch || creep.build(firstMatch.constructionSite) == ERR_INVALID_TARGET) {
                    delete creep.memory.building;
                }
            } else {
                const tConfig = {
                    mode: 'consecutive',
                    threshold: {num: 5, adjacencyMargin: 2},
                    rmCallHistOnLimit: true,
                    diversionTarget: () => idle(creep)
                };
                const wrappedRec = {
                    receiver: pathing.walkCheapestPath,
                    bindingTarget: pathing
                };

                const limitedWalking = new utilities.CallLimitAdapter(wrappedRec, creep.memory, tConfig);
                limitedWalking.call([creep,
                    [creep.room.getPositionAt(creep.memory.building.pos.x, creep.memory.building.pos.y)], 5, true, range, safePathing]);
            }
        } else {
            utilities.log('A creep that is working construction did not have any construction site assigned,'
                + ' this should never happen because of dynamic task assignment.', true);
        }
    } else {
        let harvestDirectly = true;
        const threshold = getStrgWThreshold(creep.room);
        const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
            filter: scan.structureWithdrawingWrapper(scan.storageFilter, threshold)
        });
        if (targets.length > 0) {
            harvestDirectly = false;
            creep.withdraw(targets[0], RESOURCE_ENERGY);
        } else {
            const targets = creep.room.find(FIND_MY_STRUCTURES, {
                filter: scan.structureWithdrawingWrapper(scan.storageFilter, threshold)
            });
            if (targets.length > 0) {
                harvestDirectly = !pathing.walkCheapestPath(creep, [targets[0]], 5);
            }
        }

        if (harvestDirectly) {
            const sources = creep.pos.findInRange(FIND_SOURCES_ACTIVE, 1);
            if (sources.length > 0) {
                creep.harvest(sources[0]);
            } else {
                pathing.walkCheapestPath(creep, FIND_SOURCES_ACTIVE, 5);
            }
        }
    }

    if (noIdling) return 0;
}

// if the optional parameter 'noIdling' is set to true, this function won't set the given creep to an idle state
// instead it will return 1
function repair(creep, siteFilter, withdrawingFilter, noIdling = false, safePathing = true) {
    if (noIdling) creep.memory.noIdling = true;

    rmInvalidTask(creep, ['repairing', 'harvesting']);
    if (creep.memory.task == 'repairing' && creep.store[RESOURCE_ENERGY] == 0 || creep.memory.task == undefined) {
        creep.memory.task = 'harvesting';
    }

    if (creep.memory.task == 'harvesting' && creep.store.getFreeCapacity() == 0) {
        creep.memory.task = 'repairing';
    }

    if (creep.memory.task == 'repairing' && creep.memory.repairing == null) {

        const sites = creep.room.find(FIND_STRUCTURES, {filter: siteFilter})
            .sort((a, b) => a.hits - b.hits);

        if (sites.length == 0) {
            return idle(creep);
        } else {
            creep.memory.repairing = {'pos': sites[0].pos};
        }
    }

    if (creep.memory.task == 'repairing') {
        if (creep.memory.repairing != null) {
            if (creep.pos.inRangeTo(creep.memory.repairing.pos.x, creep.memory.repairing.pos.y, 3)) {
                let matches = creep.room.lookAt(creep.memory.repairing.pos.x, creep.memory.repairing.pos.y)
                    .filter(e => e.structure).map(e => e.structure);
                if (matches.length > 1) {
                    matches = matches.filter(s => s.structureType == STRUCTURE_RAMPART);
                }
                if (matches.length == 0) {
                    delete creep.memory.repairing;
                } else {
                    creep.repair(matches[0]);
                }
            } else {
                pathing.walkCheapestPath(creep,
                    [creep.room.getPositionAt(creep.memory.repairing.pos.x, creep.memory.repairing.pos.y)], 5, true, 3, safePathing);
            }
        } else {
            utilities.log('A creep that is doing wall repairs did not have a repairing target assigned,'
                + ' this should never happen because of dynamic task assignment.', true);
        }
    } else {
        let harvestDirectly = true;
        const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
            filter: withdrawingFilter
        });
        if (targets.length > 0) {
            harvestDirectly = false;
            creep.withdraw(targets[0], RESOURCE_ENERGY);
        } else {
            const targets = creep.room.find(FIND_MY_STRUCTURES, {
                filter: withdrawingFilter
            });
            if (targets.length > 0) {
                harvestDirectly = !pathing.walkCheapestPath(creep, [targets[0]], 5);
            }
        }

        if (harvestDirectly) {
            const sources = creep.pos.findInRange(FIND_SOURCES_ACTIVE, 1);
            if (sources.length > 0) {
                creep.harvest(sources[0]);
            } else {
                pathing.walkCheapestPath(creep, FIND_SOURCES_ACTIVE, 5);
            }
        }
    }

    if (noIdling) return 0;
}

function setupNewRoom(creep) {
    if (!travelToExpansionTarget(creep)) return;

    if (construct(creep, site => site.structureType == STRUCTURE_SPAWN, true) == 1) {
        const structures = creep.room.find(FIND_HOSTILE_STRUCTURES, {filter: ignoreUnbreakable(entity => true)});
        if (structures.length > 0) {
            const structures = creep.pos.findInRange(FIND_HOSTILE_STRUCTURES, 1);
            if (structures.length > 0) {
                creep.dismantle(structures[0]);
            } else {
                pathing.walkCheapestPath(creep, FIND_HOSTILE_STRUCTURES, 5);
            }
        } else {
            if (creep.room.find(FIND_MY_SPAWNS).length > 0) return;
            const spawnFlag = Game.flags[creep.room.name + '_SPWN'];
            if (spawnFlag == undefined) {
                utilities.log('The room "' + creep.room.name + '" has no flag for the building of the first spawn!'
                    + ' The appropriate name would be "' + creep.room.name + '_SPWN' + '"', true);
            } else {
                const result = creep.room.createConstructionSite(spawnFlag.pos, STRUCTURE_SPAWN);
                spawnFlag.remove();
                utilities.demolishWalls(creep.room);
            }
        }
    }
}

function moveToTargetOrIdle(creep, targetsFilter, secondaryTargetsFilter = null) {
    const targets = creep.room.find(FIND_MY_STRUCTURES, {
        filter: targetsFilter
    });
    if (targets.length < 1) {
        if (secondaryTargetsFilter == null) {
            return idle(creep);
        } else {
            const targets = creep.room.find(FIND_MY_STRUCTURES, {
                filter: secondaryTargetsFilter
            });
            if (targets.length < 1) {
                return idle(creep);
            } else {
                pathing.walkCheapestPath(creep, targets, 5);
            }
        }
    } else {
        pathing.walkCheapestPath(creep, targets, 5);
    }
}

// returns true if a command was issued to the creep, false otherwise
function mineRemotely(creep) {
    if (creep.memory.miningReturnTarget == undefined) {
        return false;
    } else if (creep.memory.miningOrigin == undefined) {
        if (utilities.calcDistance(creep.pos, creep.memory.miningReturnTarget) <= 3) {
            delete creep.memory.miningReturnTarget;
        } else {
            creep.moveTo(utilities.objToRoomPos(creep.memory.miningReturnTarget));
        }
        return true;
    };

    const containsDangerousEnemies = room => {
        return room.find(FIND_HOSTILE_CREEPS, {filter: utilities.canAttack}).length > 0;
    };

    if (containsDangerousEnemies(creep.room) && creep.room.name == creep.memory.miningOrigin) {
        delete creep.memory.miningOrigin;
        return true;
    }

    if (creep.memory.miningTargetRoom == undefined) {
        if (creep.room.name != creep.memory.miningOrigin) {
            const exitFinder = Game.map.findExit(creep.room, creep.memory.miningOrigin);
            creep.moveTo(creep.pos.findClosestByRange(exitFinder));
        } else {
            delete creep.memory.miningOrigin;
            return true;
        }
    } else {
        if (creep.room.name != creep.memory.miningTargetRoom) {
            const exitFinder = Game.map.findExit(creep.room, creep.memory.miningTargetRoom);
            creep.moveTo(creep.pos.findClosestByRange(exitFinder));
        } else {
            if (creep.store[RESOURCE_ENERGY] == creep.store.getCapacity(RESOURCE_ENERGY)
                || !utilities.roomSuitableForRemoteMining(creep.room)) {

                delete creep.memory.miningTargetRoom;
                return true;
            }

            const sources = creep.pos.findInRange(FIND_SOURCES_ACTIVE, 1);
            if (sources.length > 0) {
                creep.harvest(sources[0]);
            } else {
                if (!pathing.walkCheapestPath(creep, FIND_SOURCES_ACTIVE, 5)) {
                    const spec = [{[FIND_STRUCTURES]: s => s.structureType == STRUCTURE_WALL || s.structureType == STRUCTURE_RAMPART}];
                    interactWithTargets(creep, spec, (creep, target) => creep.dismantle(target), 1);
                }
            }
        }
    }

    return true;
}

function replenishEnergy(creep, targetsFilter, secondaryTargetsFilter = null, prioWithdrawingFilter = null, setRemoteFlagOnDemand = false, harvestingThreshold = 0) {
    if (creep.store[RESOURCE_ENERGY] <= harvestingThreshold) {
        creep.memory.harvesting = true;
    } else if (creep.store[RESOURCE_ENERGY] == creep.store.getCapacity(RESOURCE_ENERGY)) {
        creep.memory.harvesting = false;
    }

    if (creep.memory.harvesting) {
        let harvestDirectly = true;
        if (prioWithdrawingFilter != null) {
            const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
                filter: prioWithdrawingFilter
            });
            if (targets.length > 0) {
                harvestDirectly = false;
                creep.withdraw(targets[0], RESOURCE_ENERGY);
            } else {
                const targets = creep.room.find(FIND_MY_STRUCTURES, {
                    filter: prioWithdrawingFilter
                });
                if (targets.length > 0) {
                    harvestDirectly = !pathing.walkCheapestPath(creep, [targets[0]], 5);
                }
            }
        }

        if (harvestDirectly) {
            const sources = creep.pos.findInRange(FIND_SOURCES_ACTIVE, 1);
            if (sources.length > 0) {
                creep.harvest(sources[0]);
            } else {
                if (!pathing.walkCheapestPath(creep, FIND_SOURCES_ACTIVE, 5)) {
                    if (utilities.calcEnergyQuotient(creep) > 0.2) {
                        creep.memory.harvesting = false;
                    } else if (setRemoteFlagOnDemand) {
                        creep.memory.miningTargetRoom = utilities.getRemoteMiningRoomName(creep.room);
                        creep.memory.miningOrigin = creep.room.name;
                        creep.memory.miningReturnTarget = creep.room.find(FIND_MY_SPAWNS)[0].pos;
                    }
                }
            }
        }
    } else {
        const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
            filter: targetsFilter
        });
        if (targets.length > 0) {
            creep.transfer(targets[0], RESOURCE_ENERGY);
            return;
        }

        if (secondaryTargetsFilter != null &&
            creep.room.find(FIND_MY_STRUCTURES, {filter: targetsFilter}).length == 0) {

            const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
                filter: secondaryTargetsFilter
            });
            if (targets.length > 0) {
                creep.transfer(targets[0], RESOURCE_ENERGY);
                return;
            }
        }

        return moveToTargetOrIdle(creep, targetsFilter, secondaryTargetsFilter);
    }
}

let unitTaskIdsToTaskExecutors = {};
unitTaskIdsToTaskExecutors[taskconsts.tasks.ENERGY_HARVESTING.id] = function(creep) {
    if (!mineRemotely(creep)) {
        replenishEnergy(creep, scan.structureDepositingWrapper(scan.storageFilter), scan.energyStoragePrimaryFilter, null, true);
    }
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.CONTROLLER_UPGRADING.id] = function(creep) {
    if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] == 0) {
        creep.memory.upgrading = false;
    } else if (!creep.memory.upgrading && creep.store.getFreeCapacity() == 0) {
        creep.memory.upgrading = true;
    }

    if (creep.memory.upgrading) {
        const controller = creep.pos.findInRange([creep.room.controller], 3)[0];
        if (controller != undefined) {
            creep.upgradeController(controller);
        } else {
            pathing.walkCheapestPath(creep, [creep.room.controller], 5, false, 3);
        }
    } else {
        const sourceFilter = Memory[creep.room.name].placedCtrlLink ? scan.linkFilter : scan.structureWithdrawingWrapper(scan.storageFilter, getStrgWThreshold(creep.room));
        const energySources = creep.room.find(FIND_MY_STRUCTURES, {
            filter: sourceFilter
        });

        if (energySources.length > 0) {
            const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
                filter: sourceFilter
            });
            if (targets.length > 0) {
                creep.withdraw(targets[0], RESOURCE_ENERGY);
            } else {
                pathing.walkCheapestPath(creep, energySources, 5);
            }

        } else {
            let sources = creep.pos.findInRange(FIND_SOURCES_ACTIVE, 1);
            if (sources.length > 0) {
                creep.harvest(sources[0]);
            } else {
                pathing.walkCheapestPath(creep, FIND_SOURCES_ACTIVE, 5);
            }
        }
    }
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.TOWER_CONSTRUCTION.id] = function(creep) {
    construct(creep, site => site.structureType == STRUCTURE_TOWER);
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.EXTENSION_CONSTRUCTION.id] = function(creep) {
    construct(creep, site => site.structureType == STRUCTURE_EXTENSION, false, true, 1);
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.INFLUENCE_EXPANSION.id] = function(creep) {
    if (scan.claimerFilter(creep)) {
        claim(creep);
    } else if (scan.workerFilter(creep)) {
        setupNewRoom(creep);
    } else {
        expandAggressively(creep);
    }
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.ROAD_CONSTRUCTION.id] = function(creep) {
    construct(creep, site => site.structureType == STRUCTURE_ROAD);
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.WALL_CONSTRUCTION.id] = function(creep) {
    const towerExists = creep.room.find(FIND_MY_STRUCTURES, {
        filter: scan.towerFilter
    }).length > 0;
    const fallbackFilter = site => site.structureType == STRUCTURE_WALL;
    const siteFilter = towerExists ? site => site.structureType == STRUCTURE_WALL || site.structureType == STRUCTURE_RAMPART : fallbackFilter;
    construct(creep, siteFilter, false, true);
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.TOWER_REFUELING.id] = function(creep) {
    replenishEnergy(creep, scan.towerRefuelingFilter, null, scan.structureWithdrawingWrapper(scan.storageFilter, getStrgWThreshold(creep.room)));
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.SCOUTING.id] = function(creep) {
    const target = creep.memory.scoutingTarget;
    creep.moveTo(utilities.objToRoomPos(target));
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.STORAGE_CONSTRUCTION.id] = function(creep) {
    construct(creep, site => site.structureType == STRUCTURE_STORAGE);
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.ENERGY_TRANSFERRING.id] = function(creep) {
    const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (utilities.calcDistance(creep.pos, spawn.pos) < 10
        && creep.store[RESOURCE_ENERGY] <= 49) {
        const eHeap = spawn.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {filter: h => h.amount >= 50})[0];
        if (eHeap) {
            if (creep.pickup(eHeap) == ERR_NOT_IN_RANGE) {
                pathing.walkCheapestPath(creep, [eHeap], 5);
            }
            return;
        }
    }

    const configPrimaryFilter = linkThreshold => {
        return structure => {
            return scan.structureDepositingWrapper(scan.energyStoragePrimaryFilter, 10)(structure)
                || scan.structureDepositingWrapper(scan.supplierLinkFilter, linkThreshold)(structure);
        }
    };

    if (creep.room.find(FIND_MY_STRUCTURES, {filter: configPrimaryFilter(500)}).length > 0) {
        const withdrawingFilter = scan.structureWithdrawingWrapper(scan.storageFilter, creep.store.getFreeCapacity());
        replenishEnergy(creep, configPrimaryFilter(50), null, withdrawingFilter, false, 49);
    } else {
        replenishEnergy(creep, scan.structureDepositingWrapper(scan.storageFilter), scan.energyStoragePrimaryFilter, null);
    }
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.WALL_REPAIRING.id] = function(creep) {
    repair(creep, s => {
        return (s.structureType == STRUCTURE_WALL || s.structureType == STRUCTURE_RAMPART)
            && s.hits < s.hitsMax;
    }, structure => scan.structureWithdrawingWrapper(scan.storageFilter, getStrgWThreshold(creep.room))(structure) || scan.linkWithdrawingFilter(structure));
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.CREEP_DEFENSE.id] = function(creep) {
    const target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (target == null) {
        creep.memory.taskId = -1;
        return;
    }

    if (creep.attack(target) == ERR_NOT_IN_RANGE
        && !scan.structIsHere(STRUCTURE_RAMPART, creep.pos)) {

        const targets = creep.room.find(FIND_HOSTILE_CREEPS);
        const result = pathing.getPathToRange(creep.pos, targets, 1, false);
        if (result.incomplete || result.path == undefined) {
            creep.memory.taskId = -1;
            return;
        }

        creep.move(creep.pos.getDirectionTo(result.path[0]));
    }
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.LINK_CONSTRUCTION.id] = function(creep) {
    construct(creep, site => site.structureType == STRUCTURE_LINK);
};

unitTaskIdsToTaskExecutors[taskconsts.tasks.RECEIVER_OPERATION.id] = function(creep) {
    rmInvalidTask(creep, ['supplying', 'harvesting']);
    if (creep.memory.task == 'supplying' && creep.store[RESOURCE_ENERGY] == 0 || creep.memory.task == undefined) {
        creep.memory.task = 'harvesting';
        delete creep.memory.supplying;
    }

    if (creep.memory.task == 'harvesting' && creep.store.getFreeCapacity() == 0) {
        creep.memory.task = 'supplying';
    }

    if (creep.memory.task == 'supplying' && creep.memory.supplying == null) {
        const sourcePos = utilities.objToRoomPos(creep.memory.sourceLink);
        let sites = sourcePos.findInRange(FIND_STRUCTURES, 10, {
            filter: s => {
                return s.structureType == STRUCTURE_TOWER && utilities.calcEnergyQuotient(s) < 0.8;
            }
        });

        if (sites.length == 0) {
            sites = sourcePos.findInRange(FIND_STRUCTURES, 15, {
                filter: scan.wallFilter
            }).sort((a, b) => a.hits - b.hits);
        }

        if (sites.length == 0) {
            return;
        } else {
            creep.memory.supplying = {'pos': sites[0].pos};
        }
    }

    if (creep.memory.task == 'supplying') {
        if (creep.memory.supplying != null) {
            const firstMatch = creep.room.lookAt(creep.memory.supplying.pos.x, creep.memory.supplying.pos.y)
                .filter(e => e.structure).map(e => e.structure)
                .filter(s => {
                    return s.structureType != STRUCTURE_LINK && !(s.structureType == STRUCTURE_TOWER && utilities.calcEnergyQuotient(s) == 1);
                })[0];

            if (!firstMatch) {
                delete creep.memory.supplying;
                return;
            }

            const targetIsTower = firstMatch.structureType == STRUCTURE_TOWER;
            const range = targetIsTower ? 1 : 3;
            if (creep.pos.inRangeTo(creep.memory.supplying.pos.x, creep.memory.supplying.pos.y, range)) {
                targetIsTower ? creep.transfer(firstMatch, RESOURCE_ENERGY) : creep.repair(firstMatch);
            } else {
                pathing.walkCheapestPath(creep,
                    [creep.room.getPositionAt(creep.memory.supplying.pos.x, creep.memory.supplying.pos.y)], 5, true, range, true);
            }
        } else {
            utilities.log('A creep that is operating a receiver did not have a supplying target assigned.', true);
        }
    } else {
        if (creep.pos.inRangeTo(creep.memory.sourceLink, 1)) {
            const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
                filter: scan.linkFilter
            });
            creep.withdraw(targets[0], RESOURCE_ENERGY);
        } else {
            pathing.walkCheapestPath(creep, [creep.memory.sourceLink], 5, true, null, true);
        }
    }
};


let taskexecution = {

    unitTaskIdsToTaskExecutors: unitTaskIdsToTaskExecutors,

    depositEnergy: function(creep) {
        if (creep.store[RESOURCE_ENERGY] == 0) return false;

        const storage = creep.room.find(FIND_MY_STRUCTURES, {
            filter: scan.storageFilter
        })[0];

        if (storage == undefined) return false;

        const targets = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
            filter: scan.storageFilter
        });
        if (targets.length > 0) {
            creep.transfer(targets[0], RESOURCE_ENERGY);
        } else {
            pathing.walkCheapestPath(creep, [storage], 5);
        }

        return true;
    }

}


module.exports = taskexecution;

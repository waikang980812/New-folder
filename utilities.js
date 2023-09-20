"use strict";

const exitFinders = [FIND_EXIT_LEFT, FIND_EXIT_RIGHT, FIND_EXIT_TOP, FIND_EXIT_BOTTOM];
// includes natural deaths, planned suicides
// and the occasional creep being killed from outside our walls while passing by
// (per room)
const maxTolerableWorkerDeathFrequency = {count: 3, timespan: 50};


function log(message, mail = false) {
    if (mail) Game.notify(message, 180);
    console.log(message);
}

// the range of the possible numbers is inclusive on both ends
function getRandomInt(min, max) {
    return Math.floor(Math.random() * (Math.floor(max) - Math.ceil(min) + 1)) + min;
}

function fnCheckSum(fn) {
    function getPart(s, sep, index) {
        function FissionException(message) {
            this.message = message;
        }

        const parts = s.split(sep);
        if (parts.length < 2) {
            throw new FissionException('The separator "' + sep + '" could not be found');
        }

        if (index >= parts.length) throw new FissionException('Index out of range');
        return parts[index];
    }

    const text = fn.toString();
    const sig = getPart(getPart(text, '(', 1), ')', 0);

    const charSum512 = s => {
        let sum = 0;
        for (let i = 0; i < s.length; i++) {
            sum += s.charCodeAt(i);
        }
        return sum % 512;
    };

    return fn.length + '$' + text.length % 512 + '$' + charSum512(text);
}

class CallLimitAdapter {
    constructor(receiverWrapper, callHistoryParent, thresholdConfig) {
        function UnsupportedModeException(message) {
            this.message = message;
        }

        this.modesToLimitGauges = {
            consecutive: function(records) {
                const rev = records.slice().reverse();
                let previousTick = rev[0];
                let count = 1;
                for (let i = 1; i < rev.length; i++) {
                    if (previousTick - rev[i] > this.threshold.adjacencyMargin) break;
                    previousTick = rev[i];
                    count++;
                }

                return count;
            },
            frequency: function(records) {
                if (records.length < 1) return 0;
                return records.length/(Game.time - records[0]);
            }
        };

        if (!Object.keys(this.modesToLimitGauges).includes(thresholdConfig.mode)) {
            throw new UnsupportedModeException('The specified mode does not exist');
        }

        if (callHistoryParent.callHist == undefined) {
            callHistoryParent.callHist = {};
        }
        const recIdentifier = fnCheckSum(receiverWrapper.receiver);
        if (callHistoryParent.callHist[recIdentifier] == undefined) {
            callHistoryParent.callHist[recIdentifier] = [];
        }

        this.callHist = callHistoryParent.callHist;
        this.mode = thresholdConfig.mode;
        this.threshold = thresholdConfig.threshold;
        this.recIdentifier = recIdentifier;
        this.receiver = receiverWrapper.receiver.bind(receiverWrapper.bindingTarget);
        this.rmCallHistOnLimit = thresholdConfig.rmCallHistOnLimit;
        this.diversionTarget = thresholdConfig.diversionTarget;
    }

    calcMaxHistSize() {
        switch(this.mode) {
            case 'consecutive':
                return this.threshold.num;
            case 'frequency':
                return this.threshold.bucketsize;
            default:
                return 10;
        }
    }

    call(args) {
        let records = this.callHist[this.recIdentifier];
        const maxHistSize = this.calcMaxHistSize();
        if (records.length > maxHistSize) {
            records.splice(0, records.length - maxHistSize);
        }

        const callGauge = this.modesToLimitGauges[this.mode].bind(this)(records);
        if (callGauge >= this.threshold.num) {
            if (this.rmCallHistOnLimit) this.callHist[this.recIdentifier] = [];
            if (this.diversionTarget) return {diverted: this.diversionTarget()};
        } else {
            records.push(Game.time);
            return {called: this.receiver(...args)};
        }
    }
}

function getElementIndex(mode) {
    const modes = ['max', 'min'];

    function InvalidModeException(message) {
        this.message = message;
    }
    if (!modes.includes(mode)) throw new InvalidModeException('The mode "' + mode + '" is not supported');

    const swapController = mode == 'max' ? (fst, snd) => fst < snd : (fst, snd) => fst > snd;

    return arr => {
        let bestIndex, bestElement;
        for (let i = 0; i < arr.length; i++) {
            if (bestElement == undefined || swapController(bestElement, arr[i])) {
                bestIndex = i;
                bestElement = arr[i];
            }
        }

        return bestIndex;
    }
}

function calcEnergyQuotient(storingStruct) {
    return storingStruct.store[RESOURCE_ENERGY] / storingStruct.store.getCapacity(RESOURCE_ENERGY);
}

function countBodyParts(creeps) {
    if (creeps.length == 0) return 0;
    return creeps.map(creep => creep.body.length).reduce((a, b) => a + b);
}

function canAttack(creep) {
    for (const part of creep.body) {
        if ([ATTACK, RANGED_ATTACK].includes(part.type) && part.hits > 0) return true;
    }
    return false;
}

function getFlagToScout(room) {
    const flagNames = Object.keys(Memory.flagNamesToOccupyingForceNames)
        .filter(name => Memory.flagNamesToOccupyingForceNames[name].includes(room.name));

    if (flagNames.length == 0) {
        return null;
    } else {
        if (flagNames.length > 1) {
            log('The room "' + room.name + '" is assigned as an occupying force to multiple other rooms.', true);
        }

        return Game.flags[flagNames[0]];
    }
}

function getWallPlacingRoomIndex(next = false) {
    if (!next) return Memory.wallPlacingRoomIndex;
    if (++Memory.wallPlacingRoomIndex > Memory.occupiedRoomNames.length - 1) {
        Memory.wallPlacingRoomIndex = 0;
    }

    return Memory.wallPlacingRoomIndex;
}

function getExitFinderIndex() {
    if (++Memory.exitFinderIndex > 3) {
        Memory.exitFinderIndex = 0;
    }

    return Memory.exitFinderIndex;
}

function addWorkerDeathRecord(room) {
    // only continue if we control the room
    if (Memory[room.name] == undefined) return;
    if (Memory[room.name].workerDeathRecords == undefined) Memory[room.name].workerDeathRecords = [];
    Memory[room.name].workerDeathRecords.push(Game.time);
    processWorkerDeath(room);
}

function processWorkerDeath(room) {
    if (Memory[room.name].workerDeathRecords.length <= maxTolerableWorkerDeathFrequency.count) return;
    if (room.find(FIND_HOSTILE_CREEPS).length == 0) return;

    log('The WORKER death frequency in room "' + room.name + '" is not tolerable!', true);
    activateSafeMode(room);
}

function activateSafeMode(room) {
    try {
        log('Activating Safe Mode in room "' + room.name + '"', true);
        const result = room.controller.activateSafeMode();
        if (result == OK) {
            refreshWorkerDeathRecords([room], true);
        } else {
            throw new Error('Activation failed with return value: ' + result);
        }
    } catch (e) {
        log(e, true);
    }
}

function refreshWorkerDeathRecords(rooms, completeReset = false) {
    rooms.forEach(room => {
        if (Memory[room.name] == undefined || Memory[room.name].workerDeathRecords == undefined) return;
        if (completeReset) {
            Memory[room.name].workerDeathRecords = [];
            return;
        }
        Memory[room.name].workerDeathRecords = Memory[room.name].workerDeathRecords.filter(record => {
            return record + maxTolerableWorkerDeathFrequency.timespan >= Game.time;
        });
    });
}


const utilities = {

    controlTowers: function() {
        const groupedAttack = (towers, target) => {
            towers.forEach(t => t.attack(target));
        };

        const isBustedWall = struct => {
            return (struct.structureType == STRUCTURE_WALL ||
                (struct.structureType == STRUCTURE_RAMPART && struct.my)) &&
                struct.hits < 10000;
        };

        const groupedRepair = (towers, target) => {
            towers.forEach(t => t.repair(target));
        };

        const groupedHeal = (towers, target) => {
            towers.forEach(t => t.heal(target));
        };

        const towers = Memory.towerIds.map(towerId => {
            return Game.getObjectById(towerId);
        }).filter(t => t);

        const groupedTowers = towers.reduce((groups, tower) => {
            return {
                ...groups,
                [tower.room.name]: [...(groups[tower.room.name] || []), tower]
            };
        }, {});
        for (const [roomName, towers] of Object.entries(groupedTowers)) {
            const ctrlStruct = Game.rooms[roomName].find(FIND_MY_SPAWNS)[0];
            if (!ctrlStruct) continue;

            const createThresholdConfBase = conf => {
                return value => {
                    return {
                        ...conf,
                        threshold: value
                    };
                }
            }

            const base = createThresholdConfBase({
                mode: 'frequency',
                rmCallHistOnLimit: false,
                diversionTarget: () => true
            });

            const specifyLimitDetails = (receiver, threshold) => {
                return new CallLimitAdapter({receiver: receiver}, Memory[roomName], base(threshold));
            };

            const hostile = ctrlStruct.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
            if (hostile) {
                const attackLimiter = specifyLimitDetails(groupedAttack, {num: 0.06, bucketsize: 50});
                if (!attackLimiter.call([towers, hostile]).diverted) continue;
            }

            const creepToHeal = ctrlStruct.pos.findClosestByRange(FIND_MY_CREEPS, {
                filter: creep => creep.hits < creep.hitsMax
            });
            if (creepToHeal) {
                const healLimiter = specifyLimitDetails(groupedHeal, {num: 0.035, bucketsize: 6});
                if (!healLimiter.call([towers, creepToHeal]).diverted) continue;
            }

            const repairTarget = ctrlStruct.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: struct => {
                    return (![STRUCTURE_ROAD, STRUCTURE_WALL, STRUCTURE_RAMPART].includes(struct.structureType)
                        && struct.hits && struct.structureType != STRUCTURE_CONTROLLER
                        && struct.hits < struct.hitsMax)
                        || isBustedWall(struct)
                }
            });
            if (repairTarget) {
                const repairLimiter = specifyLimitDetails(groupedRepair, {num: 0.02, bucketsize: 30});
                if (!repairLimiter.call([towers, repairTarget]).diverted) continue;
            }
        }
    },

    // has to be called after all other code has ran through for the given tick
    // (otherwise the monitored data is not accurate)
    monitorCpu: function() {
        if (Memory.cpuMonitoringHeartbeat != undefined) {
            if (Memory.cpuMonitoringHeartbeat - Game.time < -1) {
                log('A CPU limit transgression was detected: '
                    + 'heartbeat: ' + Memory.cpuMonitoringHeartbeat + ' game time: ' + Game.time, true);
            }
        }

        Memory.cpuMonitoringHeartbeat = Game.time;

        if (Memory.cpuUsages == undefined || Game.time % 300 == 0) Memory.cpuUsages = [];
        Memory.cpuUsages.push(Game.cpu.getUsed()/Game.cpu.limit);
    },

    calcAverageCpuUsage: function() {
        const usages = Memory.cpuUsages;
        if (usages == undefined || usages.length == 0) {
            log('The CPU usage mem prop is undefined or empty.', true);
            return 1.0;
        }
        return usages.reduce((a, b) => a + b)/usages.length;
    },

    resetBuilderFlags: function() {
        for (const creep of Object.values(Game.creeps)) {
            creep.memory.building = null;
        }
    },

    resetRepairerFlags: function() {
        for (const creep of Object.values(Game.creeps)) {
            creep.memory.repairing = null;
        }
    },

    renewCreep: function(room, creepFilter) {
        const spawn = room.find(FIND_MY_SPAWNS)[0];

        const creepTargets = spawn.pos.findInRange(FIND_MY_CREEPS, 1, {
            filter: creepFilter
        });

        if (creepTargets.length != 0) {
            spawn.renewCreep(creepTargets[0]);
        }
    },

    getFlagToScout: getFlagToScout,

    getWallPlacingInfo: function() {
        const exitIndex = getExitFinderIndex();
        return {
            'exitFinderIndex': exitIndex,
            'roomIndex': getWallPlacingRoomIndex(exitIndex == 0)
        }
    },

    getRoomActionIndex: function() {
        if (++Memory.roomActionIndex > 3) {
            Memory.roomActionIndex = 0;
        }

        return Memory.roomActionIndex;
    },

    demolishWalls: function(room) {
        room.find(FIND_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_WALL
        }).forEach(wall => wall.destroy());
    },

    cleanupExpansionFlags: function(room) {
        const flags = room.find(FIND_FLAGS).filter(f => {
            return Object.keys(Memory.flagNamesToOccupyingForceNames).includes(f.name);
        });
        flags.forEach(f => {
            delete Memory.flagNamesToOccupyingForceNames[f.name];
            f.remove();
        });
    },

    resetSafExceptions: function(room) {
        for (const key of Object.keys(Memory[room.name])) {
            if (key.startsWith('safExceptions_')) {
                Memory[room.name][key] = 0;
            }
        }
    },

    getSpawningEnergy: function(room) {
        return room.energyAvailable;
    },

    calcSpawningEnergyQuotient: function(room) {
        return room.energyAvailable/room.energyCapacityAvailable;
    },

    calcEnergyQuotient: calcEnergyQuotient,

    updateCreepRooms: function() {
        for (const creep of Object.values(Game.creeps)) {
            creep.memory.roomName = creep.room.name;
        }
    },

    clearDeadCreepsMemory: function(attachedSupervisor = null) {
        for (const name in Memory.creeps) {
            if (!Game.creeps[name]) {
                if (attachedSupervisor) attachedSupervisor(Memory.creeps[name]);
                delete Memory.creeps[name];
            }
        }
    },

    processCreepDeath: function(deadCreepMemory) {
        // only continue if creep was a WORKER and the roomName property exists
        if (deadCreepMemory.type != 5 || deadCreepMemory.roomName == undefined) return;
        const room = Game.rooms[deadCreepMemory.roomName];
        if (room == undefined) return;
        addWorkerDeathRecord(room);
    },

    refreshWorkerDeathRecords: refreshWorkerDeathRecords,

    countBodyParts: countBodyParts,

    getMode: function(room) {
        return countBodyParts(room.find(FIND_HOSTILE_CREEPS)) >= 100 ? "siege" : "default";
    },

    cutMyLifeIntoPieces: function(rooms) {
        rooms.forEach(room => {
            const enemyParts = countBodyParts(room.find(FIND_HOSTILE_CREEPS));
            if (enemyParts > 0) {
                const friendlyParts = countBodyParts(room.find(FIND_MY_CREEPS));
                if (friendlyParts == 0 || enemyParts/friendlyParts >= 3) {
                    log('The room "' + room.name + '" is overwhelmed!', true);
                    activateSafeMode(room);
                } else {
                    const spawn = room.find(FIND_MY_SPAWNS)[0];
                    if (spawn.hits < spawn.hitsMax) {
                        log('The spawn of room "' + room.name + '" is damaged!', true);
                        activateSafeMode(room);
                    }
                }
            }
        });
    },

    getRemoteMiningRoomName: function(originRoom) {
        let suggestions = Object.values(Game.map.describeExits(originRoom.name));
        if (Memory.unsuitableForRemoteMining == undefined) {
            Memory.unsuitableForRemoteMining = [];
        } else {
            suggestions = suggestions.filter(roomName => !Memory.unsuitableForRemoteMining.includes(roomName));
        }

        return suggestions[getRandomInt(0, suggestions.length - 1)];
    },

    roomSuitableForRemoteMining: function(room, acceptableOwners = []) {
        const markRoomAsUnsuitable = room => {
            Memory.unsuitableForRemoteMining.push(room.name);
            return false;
        };

        if (room.controller) {
            if (room.controller.reservation) return markRoomAsUnsuitable(room);

            if (room.controller.owner && !acceptableOwners.includes(room.controller.owner.username)) {
                return markRoomAsUnsuitable(room);
            }
        }

        const dangerousEnemiesExist = room.find(FIND_HOSTILE_CREEPS).filter(canAttack).length > 0;
        if (dangerousEnemiesExist) return markRoomAsUnsuitable(room);

        const invaderCorePresent = room => {
            return room.find(FIND_STRUCTURES, {
                filter: { owner: { username: 'Invader' } }
            }).length > 0;
        };
        if (invaderCorePresent(room)) return markRoomAsUnsuitable(room);

        if (room.find(FIND_SOURCES).length == 0) {
            return markRoomAsUnsuitable(room);
        }

        return true;
    },

    canAttack: canAttack,

    getRandomInt: getRandomInt,

    terrainWallAtDangerPos: function(dangerPos) {
        const terrPositions = Memory[dangerPos.roomName].terrainWallDangerPositions;
        for (let i = 0; i < terrPositions.length; i++) {
            if (terrPositions[i].x == dangerPos.x && terrPositions[i].y == dangerPos.y) return true;
        }

        return false;
    },

    exitFinders: exitFinders,

    saveRoomExits: function(rooms) {
        for (const room of rooms) {
            if (Memory[room.name].roomExits != undefined) continue;

            let exPositions = [];
            exitFinders.forEach(f => exPositions.push(...room.find(f)));
            Memory[room.name].roomExits = exPositions;
        }
    },

    controlLinks: function(suppliers, receivers) {
        // sorting the paths by descending energy quotient
        suppliers.sort((a, b) => calcEnergyQuotient(b) - calcEnergyQuotient(a));

        let waitingSupplierExists = true;
        for (const receiver of receivers) {
            if (!waitingSupplierExists) break;

            if (utilities.calcEnergyQuotient(receiver) < 0.8) {
                waitingSupplierExists = false;
                let transferredEnergy = false;
                for (const supplier of suppliers) {
                    if (supplier.cooldown > 0) continue;
                    if (utilities.calcEnergyQuotient(supplier) > 0.2) {
                        if (!transferredEnergy) {
                            if (supplier.transferEnergy(receiver) == OK) transferredEnergy = true;
                        } else {
                            waitingSupplierExists = true;
                        }
                    }
                }
            }
        }
    },

    log: log,

    // measures distance via own arithmetic instead of calling the API
    // assumes the given positions are in the same room
    // (since diagonally adjacent positions are only a distance of "1" away,
    // the calculation might not match your intuition of how distances should work
    // but it matches how they work in the game)
    calcDistance: function(pos1, pos2) {
        return Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
    },

    objToRoomPos: function(obj) {
        function ConversionException(message) {
            this.message = message;
        }

        const props = [obj.x, obj.y, obj.roomName];
        props.forEach(p => {
            if (p == null) {
                throw new ConversionException('Missing property in object: ' + JSON.stringify(obj));
            }
        });

        return new RoomPosition(...props);
    },

    calcMaxWorkers: function(room) {
        if (room.find(FIND_SOURCES).length >= 2) {
            if (room.controller.level > 5) {
                return 4;
            } else if (room.controller.level > 4) {
                return 5;
            }
            return 6;
        } else {
            if (room.controller.level > 4) {
                return 4;
            }
            return 5;
        }
    },

    getElementIndex: getElementIndex,

    desiredWallHitpoints: 5000000,

    CallLimitAdapter: CallLimitAdapter,

    clearAnchorBans: function(room) {
        if (Memory[room.name] == undefined || Memory[room.name].bannedAnchors == undefined) return;
        Memory[room.name].bannedAnchors = [];
    }

};


module.exports = utilities;

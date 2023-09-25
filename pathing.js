"use strict";

const scan = require('scan');
const taskconsts = require('tasks');
const utilities = require('utilities');


function MoveException(message) {
    this.message = message;
}

function PathingParamException(message) {
    this.message = message;
}

function MoveSafetyException(message) {
    this.message = message;
}


function setDangerCosts(costMatrix, roomName) {
    if (Memory[roomName] == undefined) return;

    // positions that don't have a zero-value don't get overwritten with the default terrain cost
    // even if the default cost is higher than the existing one
    // this would lead to unwalkable positions (terrain-walls) that are usually assigned a value of 255 automatically
    // being treated as walkable if a 'dangerous' value was assigned to them
    // to prevent this, we only set the 'dangerous' costs if there is no terrain-wall at a given position
    // (terrain-walls are the only type of terrain that is unwalkable)

    // positions that are completely exposed (to melee & ranged attacks)
    scan.getDangerousPositions(roomName, 'outer').forEach(pos => {
        if (!utilities.terrainWallAtDangerPos(pos)) costMatrix.set(pos.x, pos.y, 30);
    });

    // positions that are (closely) behind walls (and therefore only exposed to ranged attacks)
    scan.getDangerousPositions(roomName, 'inner').forEach(pos => {
        if (!utilities.terrainWallAtDangerPos(pos)) costMatrix.set(pos.x, pos.y, 20);
    });
}

function customizeRoomCallback(ignoreCreeps, safe, ignoreConstSites = false) {
    return roomName => {
        let room = Game.rooms[roomName];
        // the room might not be visible
        if (!room) return;

        // new cost matrix, with zero-values at all positions
        let costs = new PathFinder.CostMatrix;

        if (safe) setDangerCosts(costs, roomName);

        room.find(FIND_STRUCTURES).forEach(struct => {
            if (struct.structureType === STRUCTURE_ROAD) {
                costs.set(struct.pos.x, struct.pos.y, 1);
            } else if (struct.structureType !== STRUCTURE_CONTAINER &&
                (struct.structureType !== STRUCTURE_RAMPART || !struct.my)) {
                // non-walkable buildings
                costs.set(struct.pos.x, struct.pos.y, 0xff);
            }
        });

        if (!ignoreConstSites) {
            room.find(FIND_CONSTRUCTION_SITES, {
                filter: s => ![STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType)
            }).forEach(site => {
                costs.set(site.pos.x, site.pos.y, 0xff);
            });
        }

        if (!ignoreCreeps) {
            // avoid creeps in the room
            room.find(FIND_CREEPS).forEach(creep => {
                costs.set(creep.pos.x, creep.pos.y, 0xff);
            });
        }

        return costs;
    }
}

// result might be undefined or have 'incomplete' set to true if no path can be found to the given target
function getCheapestPath(pos, targets, ignoreCreeps = false, safe = false, ignoreConstSites = false, flee = false) {
    return PathFinder.search(
        pos, targets, {
            plainCost: 2,
            swampCost: 10,
            roomCallback: customizeRoomCallback(ignoreCreeps, safe, ignoreConstSites),
            flee: flee
        }
    );
}

// result might be undefined or have 'incomplete' set to true if no path can be found to the given target
function getShortestPath(pos, targets, ignoreCreeps = false, safe = false, ignoreConstSites = false) {
    return PathFinder.search(
        pos, targets, {
            plainCost: 1,
            swampCost: 1,
            roomCallback: customizeRoomCallback(ignoreCreeps, safe, ignoreConstSites)
        }
    );
}

let pathing = {

    // this function determines the cheapest path from the current position of the given creep to a target
    // the field 'path' in the memory of the given creep is set to an array of positions the creep should traverse
    // in order to get to the target
    // the given creep is directly moved to the first position of the path
    // creep: the creep whose position and memory should be used
    // targets: FIND_* constant/array containing the targets
    // maxPathLength: maximum length of the array of positions that should be written to the creeps memory
    // (higher values facilitate decreasing CPU-usage because path calculations don't have to be conducted as often)
    // (as the value of this parameter increases, the probability of the path calculations still being relevant when they are used decreases)
    // posTargets: (optional parameter) allows using positions directly as targets instead of having to use structures
    // (set it to true if your targets are positions)
    // rangeOverride: (optional parameter) allows overriding the range of the final position from the target
    // safe: (optional parameter) toggles safe pathing
    // flee: (optional parameter) if true, search for path away from all targets instead of towards one of them
    // returns true if the traversal of the first path position was successful, false otherwise
    walkCheapestPath: function(creep, targets, maxPathLength, posTargets = false, rangeOverride = null, safe = false, flee = false) {
        creep.memory.safePathing = safe;

        // can't walk on usual targets like Spawns, Controllers or Towers
        // so the range parameter is set to 1 by default (but can be overridden)
        const range = rangeOverride === null ? 1 : rangeOverride;

        if (typeof targets == 'number') {
            if (posTargets) throw new PathingParamException('Wrong use of "posTargets" parameter');
            targets = creep.room.find(targets);
        }

        let transformer = posTargets ? t => {return {pos: t, range: range}} : t => {return {pos: t.pos, range: range}};
        targets = targets.map(transformer);

        let result = getCheapestPath(creep.pos, targets, false, safe, false, flee);

        if (result.incomplete || result.path == undefined) {
            // utilities.log('No path could be found from the creep: ' + creep.name + ' to the targets: ' + JSON.stringify(targets) + ' results: '+ JSON.stringify(result));
            utilities.log('Get Cheapest Path function return for '+ creep.name + ' return incomplete results');
            return false;
        }

        if (result.path.length > maxPathLength) result.path = result.path.slice(0, maxPathLength);
        creep.memory.path = result.path;
        try {
            safe ? this.moveSafely(creep) : this.move(creep);
            return true;
        } catch (e) {
            if (e instanceof MoveException) {
                utilities.log('No path could be found from the creep: ' + creep.name + ' to the targets: ' + JSON.stringify(targets));
            } else if (e instanceof MoveSafetyException) {
                this.handleMoveSafetyException(creep);
            } else {
                throw e;
            }

            return false;
        }
    },

    move: function(creep) {
        if (creep.fatigue) return;
        if (creep.memory.path == undefined) throw new MoveException('The given creep has no path');
        let nextPos = creep.memory.path.shift();
        if (nextPos == undefined) throw new MoveException('The path of the given creep is empty');
        nextPos = utilities.objToRoomPos(nextPos);
        creep.move(creep.pos.getDirectionTo(nextPos));
    },

    moveSafely: function(creep) {
        if (creep.fatigue) return;
        if (creep.memory.path == undefined) throw new MoveException('The given creep has no path');
        let nextPos = creep.memory.path.shift();
        if (nextPos == undefined) throw new MoveException('The path of the given creep is empty');
        nextPos = utilities.objToRoomPos(nextPos);
        if (!scan.farEnoughFromExits(nextPos, 3)) {
            throw new MoveSafetyException('The next position of the path can not be traversed safely');
        }
        creep.move(creep.pos.getDirectionTo(nextPos));
    },

    handleMoveSafetyException: function(creep) {
        creep.memory.path = undefined;
        if (creep.memory.taskId == taskconsts.tasks.WALL_CONSTRUCTION.id || creep.memory.taskId == taskconsts.tasks.EXTENSION_CONSTRUCTION.id) {
            creep.memory.building = null;
            const propBase = 'safExceptions_';
            if (Memory[creep.room.name] != undefined) {
                if (Memory[creep.room.name][propBase + creep.memory.taskId] == undefined) {
                    Memory[creep.room.name][propBase + creep.memory.taskId] = 1;
                } else {
                    Memory[creep.room.name][propBase + creep.memory.taskId]++;
                }

                // prevent excessive CPU usage for repetitive path calculations
                // that ultimately don't get used because they are not safe
                if (Memory[creep.room.name][propBase + creep.memory.taskId] > 20) {
                    creep.memory.oldTaskId = creep.memory.taskId;
                    creep.memory.taskId = -1;
                    if (Memory[creep.room.name].taskIdsToBlockageTimes == undefined) {
                        Memory[creep.room.name].taskIdsToBlockageTimes = {};
                    }
                    Memory[creep.room.name].taskIdsToBlockageTimes[creep.memory.taskId] = -1;
                }
            }
        }
    },

    // result might have 'incomplete' set to true or have result.path be undefined if no path could be found to the given target
    // if the targets are non-walkable, range should be set to 1
    getPathToRange: function(pos, targets, range, ignoreCreeps, selectionMethod = 'cheapest', safe = false, ignoreConstSites = false) {
        if (range >= 0) {
            targets = targets.map(target => {
                return {pos: target.pos, range: range}
            });
        } else {
            throw new PathingParamException('Range must be positive');
        }

        if (selectionMethod == 'cheapest') {
            return getCheapestPath(pos, targets, ignoreCreeps, safe, ignoreConstSites);
        } else if (selectionMethod == 'shortest') {
            return getShortestPath(pos, targets, ignoreCreeps, safe, ignoreConstSites);
        } else {
            throw new PathingParamException('Wrong use of "selectionMethod" parameter');
        }
    },

    getTerrainWallDangerPositions: function(room) {
        let terrainWallPositions = [];
        const dangerPositions = scan.getDangerousPositions(room.name, 'outer')
            .concat(scan.getDangerousPositions(room.name, 'inner'));
        dangerPositions.forEach(pos => {
            if (room.lookAt(pos.x, pos.y).filter(e => e.type == LOOK_TERRAIN && e.terrain == 'wall').length > 0) {
                terrainWallPositions.push(pos);
            }
        });

        return terrainWallPositions;
    },

    // not meant to be used for moving creeps, as the returned path might contain invalid positions
    // furthermore, there is no guarantee that the positions are walkable
    createSpiralPath: function(origin, maxStraightLength) {
        let path = [];
        let {x, y} = origin;
        path.push({x: x, y: y});
        let directionModifier = 1;
        for (let i = 1; i <= maxStraightLength; i++) {
            for (let j = 0; j < i; j++) {
                y += directionModifier;
                path.push({x: x, y: y});
            }

            for (let j = 0; j < i; j++) {
                x += directionModifier;
                path.push({x: x, y: y});
            }

            directionModifier *= -1;
        }

        return path;
    }
};


module.exports = pathing;
module.exports.MoveException = MoveException;
module.exports.MoveSafetyException = MoveSafetyException;

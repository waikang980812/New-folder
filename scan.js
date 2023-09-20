"use strict";

const creeps = require('creeps');
const utilities = require('utilities');


const distMods = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const roomEdgeScalars = [0, 49];


function ScanException(message) {
    this.message = message;
}


class Square {
    constructor(center, length, room) {
        if (length % 2 != 1) throw new ScanException('The square has to have an uneven length');
        this.center = center;
        this.length = length;
        this.room = room;
        this.isValid = true;
        this.positions = [];
        let distanceToEdges = (length - 1)/2;
        this.xLimits = [center.x - distanceToEdges, center.x + distanceToEdges];
        this.yLimits = [center.y - distanceToEdges, center.y + distanceToEdges];
        for (let x = this.xLimits[0]; x <= this.xLimits[1]; x++) {
            for (let y = this.yLimits[0]; y <= this.yLimits[1]; y++) {
                this.positions.push(this.room.getPositionAt(x, y));
                if (this.positions[this.positions.length - 1] == null) {
                    this.isValid = false;
                    break;
                }
            }
            if (this.positions[this.positions.length - 1] == null) {
                break;
            }
        }
    }

    isFree() {
        if (!this.isValid) throw new ScanException('The square is not valid');
        let result = this.room.lookAtArea(this.yLimits[0], this.xLimits[0], this.yLimits[1], this.xLimits[1], true);
        result = result.filter(subResult => {
            return subResult.type == LOOK_STRUCTURES && subResult.structure.structureType !== STRUCTURE_ROAD
                || subResult.type == LOOK_TERRAIN && subResult.terrain == 'wall'
                || subResult.type == LOOK_CONSTRUCTION_SITES
        });
        return result.length == 0;
    }
}

class NestedRectangle {
    constructor(anchor1, anchor2, room, nestingWidth) {
        this.room = room;
        this.isValid = true;

        let anchorToAnchorDirX = anchor2.x - anchor1.x > 0 ? 1 : -1;
        let anchorToAnchorDirY = anchor2.y - anchor1.y > 0 ? 1 : -1;

        this.innerPositions = [];
        this.outerPositions = [];

        let innerAnchor1 = {
            x: anchor1.x + nestingWidth*anchorToAnchorDirX,
            y: anchor1.y + nestingWidth*anchorToAnchorDirY
        };

        let innerAnchor2 = {
            x: anchor2.x + nestingWidth*anchorToAnchorDirX*-1,
            y: anchor2.y + nestingWidth*anchorToAnchorDirY*-1
        };

        let orderBounds = bounds => {
            if (bounds[0] > bounds[1]) {
                const tmp = bounds[0];
                bounds[0] = bounds[1];
                bounds[1] = tmp;
            }

            return bounds;
        };

        let xLoopBounds = orderBounds([innerAnchor1.x, innerAnchor2.x]);
        let yLoopBounds = orderBounds([innerAnchor1.y, innerAnchor2.y]);
        for (let x = xLoopBounds[0]; x <= xLoopBounds[1]; x++) {
            for (let y = yLoopBounds[0]; y <= yLoopBounds[1]; y++) {
                this.innerPositions.push(this.room.getPositionAt(x, y));
                if (this.innerPositions[this.innerPositions.length - 1] == null) {
                    this.isValid = false;
                    break;
                }
            }

            if (!this.isValid) {
                break;
            }
        }

        xLoopBounds = orderBounds([anchor1.x, anchor2.x]);
        yLoopBounds = orderBounds([anchor1.y, anchor2.y]);
        if (this.isValid) {
            for (let y = yLoopBounds[0]; y <= yLoopBounds[1]; y++) {
                for (let i = 0; i < 2; i++) {
                    this.outerPositions.push(this.room.getPositionAt(xLoopBounds[i], y));
                    if (this.outerPositions[this.outerPositions.length - 1] == null) {
                        this.isValid = false;
                        break;
                    }
                }

                if (!this.isValid) {
                    break;
                }
            }
        }

        if (this.isValid) {
            for (let x = xLoopBounds[0]+1; x <= xLoopBounds[1]-1; x++) {
                for (let i = 0; i < 2; i++) {
                    this.outerPositions.push(this.room.getPositionAt(x, yLoopBounds[i]));
                    if (this.outerPositions[this.outerPositions.length - 1] == null) {
                        this.isValid = false;
                        break;
                    }
                }

                if (!this.isValid) {
                    break;
                }
            }
        }
    }

    isFree() {
        if (!this.isValid) throw new ScanException('The rectangle is not valid');

        let getFilter = ignoreRoads => {
            let structureFilter = target => {
                return target.type == LOOK_STRUCTURES
                    && target.structure.structureType !== STRUCTURE_ROAD
            };

            if (!ignoreRoads) structureFilter = target => target.type == LOOK_STRUCTURES;

            return target => {
                return structureFilter(target)
                    || target.type == LOOK_TERRAIN && target.terrain == 'wall'
                    || target.type == LOOK_CONSTRUCTION_SITES
            };
        };

        let innerScanResult = [];
        this.innerPositions.forEach(pos => {
            innerScanResult.push(...this.room.lookAt(pos.x, pos.y));
        });
        innerScanResult = innerScanResult.filter(getFilter(false));
        if (innerScanResult.length > 0) return false;

        let outerScanResult = [];
        this.outerPositions.forEach(pos => {
            outerScanResult.push(...this.room.lookAt(pos.x, pos.y));
        });
        outerScanResult = outerScanResult.filter(getFilter(true));
        return outerScanResult.length == 0;
    }
}

function calcWallPos(exitPos, dist, xMod, yMod, room) {
    return new RoomPosition(exitPos.x + (xMod*dist), exitPos.y + (yMod*dist), room.name);
}

// only returns the straight 'cores', omits diagonals
function getWallGroupCores(room, exitFinderIndices) {
    const dist = 3;

    let wallGroupCores = [];
    for (const exitFinderIndex of exitFinderIndices) {
        let exPositions = room.find(utilities.exitFinders[exitFinderIndex]);
        if (exPositions.length == 0) continue;
        const xMod = distMods[exitFinderIndex][0];
        const yMod = distMods[exitFinderIndex][1];
        let corePositions = [calcWallPos(exPositions[0], dist, xMod, yMod, room)];
        for (let posIndex = 1; posIndex < exPositions.length; posIndex++) {
            let prevPos = exPositions[posIndex - 1];
            if (exPositions[posIndex].y == prevPos.y + Math.abs(xMod)
                && exPositions[posIndex].x == prevPos.x + Math.abs(yMod)) {
                corePositions.push(calcWallPos(exPositions[posIndex], dist, xMod, yMod, room));
            } else {
                wallGroupCores.push(corePositions);
                corePositions = [calcWallPos(exPositions[posIndex], dist, xMod, yMod, room)];
            }
        }
        wallGroupCores.push(corePositions);
    }

    return wallGroupCores;
}

// takes in a structure type (game constant) and returns a filter
// the filter returns true if there is a structure of the given type or a construction site of the given type on a given position
function getRealOrPlannedStructsFilter(structConst = null) {
    if (structConst != null) {
        return item => {return (item.type == LOOK_STRUCTURES && item.structure.structureType == structConst) ||
            (item.type == LOOK_CONSTRUCTION_SITES && item.constructionSite.structureType == structConst)};
    } else {
        return item => {return item.type == LOOK_STRUCTURES ||
            item.type == LOOK_CONSTRUCTION_SITES};
    }
}

// returns all 'free' squares (all positions that are part of the square have to be 'empty') near the given position
// pos: the position for which the search should be conducted
// sqLength: length of the sides of the squares
// distance: distance from the given position to the nearest position that is part of the square
function getFreeSquaresNearPos(pos, sqLength, distance) {
    let room = Game.rooms[pos.roomName];
    let distanceToCenters = distance + (sqLength - 1)/2;
    let xLimits = [pos.x - distanceToCenters, pos.x + distanceToCenters];
    let yLimits = [pos.y - distanceToCenters, pos.y + distanceToCenters];
    let squareCenters = [];
    let y = null;
    let x = null;
    for (let i = 0; i < yLimits.length; i++) {
        y = yLimits[i];
        for (let x = xLimits[0]; x <= xLimits[1]; x++) {
            squareCenters.push(room.getPositionAt(x, y));
        }
    }
    for (let i = 0; i < xLimits.length; i++) {
        x = xLimits[i];
        for (let y = yLimits[0] + 1; y <= yLimits[1] - 1; y++) {
            squareCenters.push(room.getPositionAt(x, y));
        }
    }

    // removes squareCenters that are not valid coordinates ('null' elements in the array)
    squareCenters = squareCenters.filter(n => n);

    let squares = squareCenters.map(squareCenter => new Square(squareCenter, sqLength, room));
    // removes squares that have invalid positions ('null' elements in the position array)
    squares = squares.filter(square => square.isValid);
    return squares.filter(square => square.isFree());
}

// checks if the given square is at least the given distance apart from elements of the given path
// offset: determines the max offset from the given index of the elements in the path array the distance should be checked for
// (the less swerving/more straight the given path is, the lower the offset can be set without it affecting the accuracy of the check)
function distanceMaintained(square, path, pathIndex, distance, offset = 5) {
    let pos = null;
    for (let i = pathIndex - offset; i <= pathIndex + offset; i++) {
        for (let j = 0; j < square.positions.length; j++) {
            pos = square.positions[j];
            if (path[i] == undefined) continue;
            if (pos.inRangeTo(path[i], distance - 1)) {
                return false;
            }
        }
    }
    return true;
}

const linkFilter = structure => {
    return structure.structureType == STRUCTURE_LINK;
};

function findSupplierLinks(room) {
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    return spawn.pos.findInRange(FIND_MY_STRUCTURES, 4, {
        filter: linkFilter
    });
}

function getPaddingPositions(coordEdges, paddingWidth, roomName) {
    let positions = [];
    for (let i = 0; i < paddingWidth; i++) {
        if (i != 0) {
            coordEdges[0]++;
            coordEdges[1]--;
        }

        for (const colCoord of coordEdges) {
            for (let rowCoord = coordEdges[0] + 1; rowCoord <= coordEdges[1] - 1; rowCoord++) {
                positions.push(new RoomPosition(colCoord, rowCoord, roomName));
                positions.push(new RoomPosition(rowCoord, colCoord, roomName));
            }
        }

        // fill in the corners
        for (let x = 0; x < 2; x++) {
            positions.push(new RoomPosition(coordEdges[x], coordEdges[0], roomName));
            positions.push(new RoomPosition(coordEdges[x], coordEdges[1], roomName));
        }
    }

    return positions;
}


let scan = {

    // do not cache the result of this function (caching game objects does not work)
    getRoomsViaSpawns: function() {
        let rooms = [];
        for (const spawn of Object.values(Game.spawns)) {
            rooms.push(spawn.room);
        }

        return rooms.filter((elem, index, self) => {
            return index === self.indexOf(elem);
        });
    },

    energyStoragePrimaryFilter: structure => {
        return (structure.structureType == STRUCTURE_EXTENSION ||
            structure.structureType == STRUCTURE_SPAWN) &&
            structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    },

    extensionFilter: structure => {
        return structure.structureType == STRUCTURE_EXTENSION;
    },

    storageFilter: structure => {
        return structure.structureType == STRUCTURE_STORAGE;
    },

    linkFilter: linkFilter,

    supplierLinkFilter: structure => {
        return linkFilter(structure) && structure.pos.findInRange(FIND_MY_SPAWNS, 4).length > 0;
    },

    linkWithdrawingFilter: structure => {
        return structure.structureType == STRUCTURE_LINK &&
            structure.store[RESOURCE_ENERGY] > 0;
    },

    structureWithdrawingWrapper: (filter, energyThreshold) => {
        return structure => {
            return filter(structure) && structure.store[RESOURCE_ENERGY] > energyThreshold;
        }
    },

    structureDepositingWrapper: (filter, threshold = 0) => {
        return structure => {
            return filter(structure) && structure.store.getFreeCapacity(RESOURCE_ENERGY) > threshold;
        }
    },

    bruiserFilter: creep => {
        return creep.memory.type == creeps.types.BRUISER;
    },

    claimerFilter: creep => {
        return creep.memory.type == creeps.types.CLAIMER;
    },

    marksmanFilter: creep => {
        return creep.memory.type == creeps.types.MARKSMAN;
    },

    medicFilter: creep => {
        return creep.memory.type == creeps.types.MEDIC;
    },

    workerFilter: creep => {
        return creep.memory.type == creeps.types.WORKER;
    },

    demolisherFilter: creep => {
        return creep.memory.type == creeps.types.DEMOLISHER;
    },

    tankFilter: creep => {
        return creep.memory.type == creeps.types.TANK;
    },

    towerFilter: structure => {
        return structure.structureType == STRUCTURE_TOWER;
    },

    towerRefuelingFilter: structure => {
        return structure.structureType == STRUCTURE_TOWER && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    },

    getRealOrPlannedStructsFilter: getRealOrPlannedStructsFilter,

    farEnoughFromExits: function(pos, minDist = 6) {
        for (const exit of Memory[pos.roomName].roomExits) {
            if (utilities.calcDistance(exit, pos) < minDist) return false;
        }

        return true;
    },

    getDangerousPositions: function(roomName, location = 'outer') {
        let coordEdges = roomEdgeScalars.slice();
        let minSafetyDist = 3;
        if (location == 'inner') {
            coordEdges[0] += 3;
            coordEdges[1] -= 3;
            minSafetyDist += 3;
        }

        return getPaddingPositions(coordEdges, 3, roomName).filter(pos => {
            if (Memory[roomName] == undefined) return true;

            for (const exit of Memory[roomName].roomExits) {
                if (utilities.calcDistance(exit, pos) < minSafetyDist) return true;
            }

            return false;
        });
    },

    // only works if all positions of the given path are in the same room
    // if you want to use this function on a path that spans multiple rooms, separate the path into multiple subpaths
    // (each only containing positions of one room) and call the function with one subpart at a time until you have found a square
    getFreeSquareNearPath: function(path, sqLength, distance, thoroughDistanceCheck, maxFreeSquaresNearPosScans, startIndex = 0) {
        if (sqLength % 2 != 1) throw new ScanException('The square has to have an uneven length');
        let pos = null;
        let scanCount = 0;
        const centerFilter = square => square.room.lookAt(square.center.x, square.center.y)
            .filter(getRealOrPlannedStructsFilter(STRUCTURE_ROAD)).length === 0;
        for (let i = startIndex; i < path.length; i++) {
            if (scanCount + 1 > maxFreeSquaresNearPosScans) break;
            pos = path[i];
            let squares = getFreeSquaresNearPos(pos, sqLength, distance);
            scanCount++;
            let square = null;
            squares = squares.filter(centerFilter);
            if (thoroughDistanceCheck) {
                for (let j = 0; j < squares.length; j++) {
                    square = squares[j];
                    if (distanceMaintained(square, path, i, distance)) {
                        return square;
                    }
                }
            } else {
                if (squares.length != 0) return squares[0];
            }
        }
        throw new ScanException('No squares could be found for the given parameters');
    },

    containsEnemies: function(room, count = 1) {
        return room.find(FIND_HOSTILE_CREEPS).length >= count;
    },

    structIsHere: function(structConst, pos) {
        const structs = Game.rooms[pos.roomName].lookAt(pos.x, pos.y).filter(item => {
            return item.type == LOOK_STRUCTURES && item.structure.structureType == structConst
        });
        return structs.length > 0;
    },

    // defenderCountBias: can ensure that the count of defending creeps is oversaturated (or undersaturated)
    // in case of an oversaturation => unoccupied ramparts that exist because their creep died
    // get occupied faster (through 'queued' defenders that serve as a backup) (e.g. bias = 2 => 2 defenders in backup max)
    rampartDefenderNeeded: function(room, defenderCountBias) {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length == 0) return false;
        let meleeRangeRamparts = [];
        hostiles.forEach(creep => {
            meleeRangeRamparts.push(...creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
                filter: struct => struct.structureType == STRUCTURE_RAMPART
            }));
        });
        meleeRangeRamparts = [...new Set(meleeRangeRamparts)]; // remove duplicates
        const bruiserCount = room.find(FIND_MY_CREEPS, {
            filter: this.bruiserFilter
        }).length;
        return meleeRangeRamparts.length - bruiserCount + defenderCountBias > 0;
    },

    NestedRectangle: NestedRectangle,

    distMods: distMods,

    getWallGroupCores: getWallGroupCores,

    getRandomSquareInRange: function(room, center, maxDistance, length) {
        const xRange = [center.x - maxDistance, center.x + maxDistance];
        const yRange = [center.y - maxDistance, center.y + maxDistance];
        const x = utilities.getRandomInt(xRange[0], xRange[1]);
        const y = utilities.getRandomInt(yRange[0], yRange[1]);

        const squareCenter = room.getPositionAt(x, y);
        if (squareCenter == null) return null;
        return new Square(squareCenter, length, room);
    },

    findSupplierLinks: findSupplierLinks,

    findReceiverLinks: function(room) {
        const supplierIds = findSupplierLinks(room).map(s => s.id);
        return room.find(FIND_MY_STRUCTURES, {
            filter: scan.linkFilter
        }).filter(link => !supplierIds.includes(link.id));
    },

    wallFilter: s => {
        return (s.structureType == STRUCTURE_WALL || s.structureType == STRUCTURE_RAMPART)
            && s.hits < s.hitsMax;
    }

};


module.exports = scan;
module.exports.ScanException = ScanException;

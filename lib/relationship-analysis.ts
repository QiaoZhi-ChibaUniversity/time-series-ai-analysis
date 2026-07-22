export type RelationshipPoint = {
  x: number;
  y: number;
};

export type RelationshipModelName =
  | "linear"
  | "quadratic"
  | "saturating_exponential";

export type RelationshipModelResult = {
  name: RelationshipModelName;
  parameterCount: number;
  equation: string;
  parameters: Record<string, number>;
  r2: number | null;
  rmse: number;
  mae: number;
  cvRmse: number | null;
  cvMae: number | null;
  aic: number;
  aicc: number | null;
};

export type RelationshipAnalysisResult = {
  sampleCount: number;
  pearsonR: number | null;
  spearmanRho: number | null;
  relationshipType:
    | "linear"
    | "monotonic_nonlinear"
    | "curved"
    | "weak_or_complex"
    | "insufficient_data";
  candidateModels: RelationshipModelResult[];
  recommendedModel: RelationshipModelName | null;
  recommendationReason: string;
  saturationModelIncluded: boolean;
  warnings: string[];
};

type FittedModel = {
  name: RelationshipModelName;
  parameterCount: number;
  equation: string;
  parameters: Record<string, number>;
  predict: (x: number) => number;
};

type ModelFactory = (points: RelationshipPoint[]) => FittedModel | null;

const EPSILON = 1e-12;

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pearsonCorrelation(xs: number[], ys: number[]) {
  if (xs.length < 2 || xs.length !== ys.length) return null;

  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSumSquares = 0;
  let ySumSquares = 0;

  for (let index = 0; index < xs.length; index += 1) {
    const xDifference = xs[index] - xMean;
    const yDifference = ys[index] - yMean;
    numerator += xDifference * yDifference;
    xSumSquares += xDifference ** 2;
    ySumSquares += yDifference ** 2;
  }

  const denominator = Math.sqrt(xSumSquares * ySumSquares);
  return denominator <= EPSILON ? null : numerator / denominator;
}

function rankValues(values: number[]) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);

  let start = 0;
  while (start < sorted.length) {
    let end = start + 1;

    while (end < sorted.length && sorted[end].value === sorted[start].value) {
      end += 1;
    }

    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) {
      ranks[sorted[index].index] = averageRank;
    }

    start = end;
  }

  return ranks;
}

function spearmanCorrelation(xs: number[], ys: number[]) {
  return pearsonCorrelation(rankValues(xs), rankValues(ys));
}

function fitLinear(points: RelationshipPoint[]): FittedModel | null {
  if (points.length < 2) return null;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < points.length; index += 1) {
    numerator += (xs[index] - xMean) * (ys[index] - yMean);
    denominator += (xs[index] - xMean) ** 2;
  }

  if (denominator <= EPSILON) return null;

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  return {
    name: "linear",
    parameterCount: 2,
    equation: "y = slope * x + intercept",
    parameters: { slope, intercept },
    predict: (x) => slope * x + intercept,
  };
}

function solveThreeByThree(matrix: number[][]) {
  const work = matrix.map((row) => [...row]);

  for (let column = 0; column < 3; column += 1) {
    let pivot = column;

    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) {
        pivot = row;
      }
    }

    if (Math.abs(work[pivot][column]) <= EPSILON) return null;
    [work[column], work[pivot]] = [work[pivot], work[column]];

    const divisor = work[column][column];
    for (let index = column; index < 4; index += 1) {
      work[column][index] /= divisor;
    }

    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = work[row][column];

      for (let index = column; index < 4; index += 1) {
        work[row][index] -= factor * work[column][index];
      }
    }
  }

  return [work[0][3], work[1][3], work[2][3]];
}

function fitQuadratic(points: RelationshipPoint[]): FittedModel | null {
  if (points.length < 3) return null;

  const xs = points.map((point) => point.x);
  const xMean = mean(xs);
  const xScale = Math.sqrt(
    xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0) / xs.length
  );

  if (xScale <= EPSILON) return null;

  let sumZ = 0;
  let sumZ2 = 0;
  let sumZ3 = 0;
  let sumZ4 = 0;
  let sumY = 0;
  let sumZY = 0;
  let sumZ2Y = 0;

  for (const point of points) {
    const z = (point.x - xMean) / xScale;
    const z2 = z ** 2;
    sumZ += z;
    sumZ2 += z2;
    sumZ3 += z ** 3;
    sumZ4 += z ** 4;
    sumY += point.y;
    sumZY += z * point.y;
    sumZ2Y += z2 * point.y;
  }

  const solution = solveThreeByThree([
    [points.length, sumZ, sumZ2, sumY],
    [sumZ, sumZ2, sumZ3, sumZY],
    [sumZ2, sumZ3, sumZ4, sumZ2Y],
  ]);

  if (!solution) return null;

  const [normalizedIntercept, normalizedLinear, normalizedQuadratic] = solution;
  const quadratic = normalizedQuadratic / xScale ** 2;
  const linear =
    normalizedLinear / xScale -
    (2 * normalizedQuadratic * xMean) / xScale ** 2;
  const intercept =
    normalizedIntercept -
    (normalizedLinear * xMean) / xScale +
    (normalizedQuadratic * xMean ** 2) / xScale ** 2;

  return {
    name: "quadratic",
    parameterCount: 3,
    equation: "y = quadratic * x^2 + linear * x + intercept",
    parameters: { quadratic, linear, intercept },
    predict: (x) => quadratic * x ** 2 + linear * x + intercept,
  };
}

function fitSaturatingExponential(
  points: RelationshipPoint[]
): FittedModel | null {
  if (points.length < 4) return null;

  const xs = points.map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  if (minX < 0 || maxX - minX <= EPSILON || maxX <= 0) return null;

  const minB = 1e-4 / Math.max(maxX, 1);
  const maxB = 10 / Math.max(maxX, 1);
  let best:
    | {
        a: number;
        b: number;
        c: number;
        rss: number;
      }
    | undefined;

  for (let index = 0; index < 80; index += 1) {
    const ratio = index / 79;
    const b = Math.exp(
      Math.log(minB) * (1 - ratio) + Math.log(maxB) * ratio
    );
    const phis = xs.map((x) => 1 - Math.exp(-b * x));
    const phiMean = mean(phis);
    const yMean = mean(points.map((point) => point.y));
    let numerator = 0;
    let denominator = 0;

    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      numerator +=
        (phis[pointIndex] - phiMean) * (points[pointIndex].y - yMean);
      denominator += (phis[pointIndex] - phiMean) ** 2;
    }

    if (denominator <= EPSILON) continue;

    const a = numerator / denominator;
    const c = yMean - a * phiMean;
    const rss = points.reduce((sum, point) => {
      const prediction = a * (1 - Math.exp(-b * point.x)) + c;
      return sum + (point.y - prediction) ** 2;
    }, 0);

    if (!best || rss < best.rss) best = { a, b, c, rss };
  }

  if (!best) return null;
  const { a, b, c } = best;

  return {
    name: "saturating_exponential",
    parameterCount: 3,
    equation: "y = a * (1 - exp(-b * x)) + c",
    parameters: { a, b, c },
    predict: (x) => a * (1 - Math.exp(-b * x)) + c,
  };
}

function evaluateModel(model: FittedModel, points: RelationshipPoint[]) {
  const predictions = points.map((point) => model.predict(point.x));
  const yValues = points.map((point) => point.y);
  const yMean = mean(yValues);
  let rss = 0;
  let absoluteError = 0;
  let totalSumSquares = 0;

  for (let index = 0; index < points.length; index += 1) {
    const residual = yValues[index] - predictions[index];
    rss += residual ** 2;
    absoluteError += Math.abs(residual);
    totalSumSquares += (yValues[index] - yMean) ** 2;
  }

  const safeRss = Math.max(rss, Number.EPSILON);
  const aic =
    points.length * Math.log(safeRss / points.length) +
    2 * model.parameterCount;
  const aicc =
    points.length > model.parameterCount + 1
      ? aic +
        (2 * model.parameterCount * (model.parameterCount + 1)) /
          (points.length - model.parameterCount - 1)
      : null;

  return {
    r2:
      totalSumSquares <= EPSILON ? null : 1 - rss / totalSumSquares,
    rmse: Math.sqrt(rss / points.length),
    mae: absoluteError / points.length,
    aic,
    aicc,
  };
}

function crossValidate(
  points: RelationshipPoint[],
  factory: ModelFactory
): { cvRmse: number; cvMae: number } | null {
  if (points.length < 10) return null;

  const foldCount = Math.min(5, Math.max(2, Math.floor(points.length / 5)));
  const sorted = [...points].sort((left, right) => left.x - right.x);
  let squaredError = 0;
  let absoluteError = 0;
  let predictionCount = 0;

  for (let fold = 0; fold < foldCount; fold += 1) {
    const training: RelationshipPoint[] = [];
    const validation: RelationshipPoint[] = [];

    sorted.forEach((point, index) => {
      if (index % foldCount === fold) validation.push(point);
      else training.push(point);
    });

    const model = factory(training);
    if (!model || validation.length === 0) return null;

    for (const point of validation) {
      const prediction = model.predict(point.x);
      if (!Number.isFinite(prediction)) return null;

      const error = point.y - prediction;
      squaredError += error ** 2;
      absoluteError += Math.abs(error);
      predictionCount += 1;
    }
  }

  if (predictionCount === 0) return null;

  return {
    cvRmse: Math.sqrt(squaredError / predictionCount),
    cvMae: absoluteError / predictionCount,
  };
}

function relationshipType(
  pearsonR: number | null,
  spearmanRho: number | null,
  models: RelationshipModelResult[]
): RelationshipAnalysisResult["relationshipType"] {
  if (pearsonR === null || spearmanRho === null) return "insufficient_data";

  const absolutePearson = Math.abs(pearsonR);
  const absoluteSpearman = Math.abs(spearmanRho);
  const linear = models.find((model) => model.name === "linear");
  const quadratic = models.find((model) => model.name === "quadratic");

  if (absolutePearson >= 0.7 && Math.abs(absoluteSpearman - absolutePearson) < 0.15) {
    return "linear";
  }

  if (absoluteSpearman >= 0.7 && absoluteSpearman - absolutePearson >= 0.15) {
    return "monotonic_nonlinear";
  }

  if (
    linear?.r2 !== null &&
    linear?.r2 !== undefined &&
    quadratic?.r2 !== null &&
    quadratic?.r2 !== undefined &&
    quadratic.r2 - linear.r2 >= 0.15
  ) {
    return "curved";
  }

  return "weak_or_complex";
}

export function analyzeRelationship(
  inputPoints: RelationshipPoint[],
  options: { includeSaturation?: boolean } = {}
): RelationshipAnalysisResult {
  const points = inputPoints.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  );
  const warnings: string[] = [];

  if (points.length < 3) {
    return {
      sampleCount: points.length,
      pearsonR: null,
      spearmanRho: null,
      relationshipType: "insufficient_data",
      candidateModels: [],
      recommendedModel: null,
      recommendationReason: "At least three valid points are required.",
      saturationModelIncluded: false,
      warnings: ["Insufficient valid observations for relationship analysis."],
    };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const pearsonR = pearsonCorrelation(xs, ys);
  const spearmanRho = spearmanCorrelation(xs, ys);

  if (pearsonR === null) warnings.push("X or Y has insufficient variance.");
  if (points.length < 10) {
    warnings.push("Fewer than 10 observations: cross-validation was skipped.");
  }

  const factories: Array<{
    name: RelationshipModelName;
    factory: ModelFactory;
  }> = [
    { name: "linear", factory: fitLinear },
    { name: "quadratic", factory: fitQuadratic },
  ];

  let saturationModelIncluded = false;
  if (options.includeSaturation) {
    if (Math.min(...xs) >= 0 && Math.max(...xs) > 0) {
      factories.push({
        name: "saturating_exponential",
        factory: fitSaturatingExponential,
      });
      saturationModelIncluded = true;
    } else {
      warnings.push(
        "The saturation model was skipped because it requires non-negative X values."
      );
    }
  }

  const candidateModels: RelationshipModelResult[] = [];

  for (const candidate of factories) {
    const fitted = candidate.factory(points);
    if (!fitted) continue;

    const metrics = evaluateModel(fitted, points);
    const crossValidation = crossValidate(points, candidate.factory);

    candidateModels.push({
      name: fitted.name,
      parameterCount: fitted.parameterCount,
      equation: fitted.equation,
      parameters: fitted.parameters,
      ...metrics,
      cvRmse: crossValidation?.cvRmse ?? null,
      cvMae: crossValidation?.cvMae ?? null,
    });
  }

  const modelsWithCrossValidation = candidateModels.filter(
    (model) => model.cvRmse !== null
  );
  let recommendedModel: RelationshipModelResult | undefined;
  let recommendationReason = "No model could be fitted reliably.";

  if (modelsWithCrossValidation.length > 0) {
    const lowestCvRmse = Math.min(
      ...modelsWithCrossValidation.map((model) => model.cvRmse as number)
    );
    const nearBest = modelsWithCrossValidation
      .filter((model) => (model.cvRmse as number) <= lowestCvRmse * 1.05)
      .sort((left, right) => left.parameterCount - right.parameterCount);

    recommendedModel = nearBest[0];
    recommendationReason =
      "Selected the simplest model within 5% of the lowest cross-validated RMSE.";
  } else if (candidateModels.length > 0) {
    recommendedModel = [...candidateModels].sort(
      (left, right) =>
        (left.aicc ?? left.aic) - (right.aicc ?? right.aic)
    )[0];
    recommendationReason =
      "Cross-validation was unavailable, so the model with the lowest AICc/AIC was selected.";
  }

  return {
    sampleCount: points.length,
    pearsonR,
    spearmanRho,
    relationshipType: relationshipType(
      pearsonR,
      spearmanRho,
      candidateModels
    ),
    candidateModels,
    recommendedModel: recommendedModel?.name ?? null,
    recommendationReason,
    saturationModelIncluded,
    warnings,
  };
}

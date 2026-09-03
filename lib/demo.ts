import type { AnswerResult } from "./types";

const SOURCE_1 = `Habitual coffee consumption has been consistently associated with a lower risk of developing type 2 diabetes. In a meta-analysis of 30 prospective cohort studies covering more than 1.1 million participants, each additional cup of coffee per day was associated with a 6% reduction in the relative risk of type 2 diabetes. The association held for both caffeinated and decaffeinated coffee, suggesting that caffeine itself is unlikely to be the primary protective component.

Researchers have proposed that chlorogenic acid and other polyphenols in coffee may improve glucose metabolism and reduce inflammation. However, the evidence base consists almost entirely of observational studies, which cannot establish a causal relationship. Randomized controlled trials of coffee consumption on glycemic outcomes have been short in duration and have produced mixed results.

It should also be noted that adding sugar, syrups, or cream to coffee may offset any potential metabolic benefit. Several cohorts observed that the inverse association weakened among participants who regularly consumed sweetened coffee beverages.`;

const SOURCE_2 = `Most healthy adults can safely consume up to 400 milligrams of caffeine per day, roughly the amount in four 8-ounce cups of brewed coffee. Intakes above this level may cause insomnia, anxiety, rapid heart rate, and digestive upset in some individuals.

People who are pregnant, sensitive to caffeine, or living with certain heart conditions should limit their intake further and consult a clinician. Current dietary guidelines do not recommend that non-coffee-drinkers start drinking coffee for disease prevention, as overall diet quality, physical activity, and weight management have far larger and better-established effects on metabolic health.`;

export const DEMO: AnswerResult = {
  question: "Does drinking coffee lower the risk of type 2 diabetes?",
  sources: [
    { title: "Coffee consumption and type 2 diabetes: systematic review (excerpt)", content: SOURCE_1 },
    { title: "Clinical guidance on caffeine intake (excerpt)", content: SOURCE_2 },
  ],
  blocks: [
    {
      text: "Observational evidence suggests that coffee drinkers do have a lower risk of developing type 2 diabetes. ",
      citations: [
        { docIndex: 0, citedText: "Habitual coffee consumption has been consistently associated with a lower risk of developing type 2 diabetes." },
      ],
    },
    {
      text: "A large meta-analysis found roughly a 6% relative risk reduction for each additional daily cup, ",
      citations: [
        { docIndex: 0, citedText: "each additional cup of coffee per day was associated with a 6% reduction in the relative risk of type 2 diabetes" },
      ],
    },
    {
      text: "and the effect appeared for both caffeinated and decaffeinated coffee. ",
      citations: [
        { docIndex: 0, citedText: "The association held for both caffeinated and decaffeinated coffee, suggesting that caffeine itself is unlikely to be the primary protective component." },
      ],
    },
    {
      text: "Some scientists consider this definitive proof that coffee prevents diabetes in all populations. ",
      citations: [],
    },
    {
      text: "In reality, the underlying studies are observational and cannot establish causation, and trial evidence remains mixed. ",
      citations: [
        { docIndex: 0, citedText: "the evidence base consists almost entirely of observational studies, which cannot establish a causal relationship" },
      ],
    },
    {
      text: "Any benefit may also be offset by sweetened coffee drinks, ",
      citations: [
        { docIndex: 0, citedText: "adding sugar, syrups, or cream to coffee may offset any potential metabolic benefit" },
      ],
    },
    {
      text: "and clinical guidance caps caffeine at about 400 mg per day and does not recommend starting coffee purely for disease prevention. ",
      citations: [
        { docIndex: 1, citedText: "Most healthy adults can safely consume up to 400 milligrams of caffeine per day" },
        { docIndex: 1, citedText: "Current dietary guidelines do not recommend that non-coffee-drinkers start drinking coffee for disease prevention" },
      ],
    },
  ],
};
